const lib = require("./lib");
const escodegen = require("escodegen");
const esprima = require("esprima");
const fs = require("fs");
const iconv = require("iconv-lite");
const path = require("path");
const {VM} = require("vm2");
const argv = require("./argv.js");

const filename = process.argv[2];

lib.debug("Analysis launched: " + JSON.stringify(process.argv));
lib.verbose(`Analyzing ${filename}`, false);
const sampleBuffer = fs.readFileSync(filename);
let encoding;
if (argv.encoding) {
	lib.debug("Using argv encoding");
	encoding = argv.encoding;
} else {
	lib.debug("Using detected encoding");
	encoding = require("jschardet").detect(sampleBuffer).encoding;
	if (encoding === null) {
		lib.warning("jschardet (v" + require("jschardet/package.json").version + ") couldn't detect encoding, using UTF-8");
		encoding = "utf8";
	} else {
		lib.debug("jschardet (v" + require("jschardet/package.json").version + ") detected encoding " + encoding);
	}
}

const sampleSource = iconv.decode(sampleBuffer, encoding);
let code = fs.readFileSync(path.join(__dirname, "patch.js"), "utf8") + sampleSource;

if (code.match("<job") || code.match("<script")) { // The sample may actually be a .wsf, which is <job><script>..</script><script>..</script></job>.
	lib.debug("Sample seems to be WSF");
	code = code.replace(/<\??\/?\w+( [\w=\"\']*)*\??>/g, ""); // XML tags
	code = code.replace(/<!\[CDATA\[/g, "");
	code = code.replace(/\]\]>/g, "");
}

function rewrite(code) {
	if (code.match("@cc_on")) {
		lib.debug("Code uses conditional compilation");
		if (!argv["no-cc_on-rewrite"]) {
			lib.info("    Replacing @cc_on statements (use --no-cc_on-rewrite to skip)...", false);
			code = code.replace(/\/\*@cc_on/g, "");
			code = code.replace(/@\*\//g, "");
		} else {
			lib.warn(
				`The code appears to contain conditional compilation statements.
If you run into unexpected results, try uncommenting lines that look like

    /*@cc_on
    <JavaScript code>
    @*/

`
			);
		}
	}

	if (!argv["no-rewrite"]) {
		lib.info("Rewriting code...", false);
		if (argv["dumb-concat-simplify"]) {
			lib.info("    Simplifying \"dumb\" concatenations (remove --dumb-concat-simplify to skip)...", false);
			code = code.replace(/'[ \r\n]*\+[ \r\n]*'/gm, "");
			code = code.replace(/"[ \r\n]*\+[ \r\n]*"/gm, "");
		}

		if (argv["preprocess"]) {
			lib.info(`    Preprocessing with uglify-js v${require("uglify-js/package.json").version} (remove --preprocess to skip)...`, false);
			const unsafe = !!argv["unsafe-preprocess"];
			const result = require("uglify-js").minify(code, {
				compress: {
					passes: 3,

					booleans: true,
					cascade: true,
					collapse_vars: true,
					comparisons: true,
					conditionals: true,
					dead_code: true,
					drop_console: false,
					evaluate: true,
					if_return: true,
					inline: true,
					join_vars: false, // readability
					keep_fargs: unsafe, // code may rely on Function.length
					keep_fnames: unsafe, // code may rely on Function.prototype.name
					keep_infinity: true, // readability
					loops: true,
					negate_iife: false, // readability
					properties: true,
					pure_getters: false, // many variables are proxies, which don't have pure getters
					/* If unsafe preprocessing is enabled, tell uglify-js that Math.* functions
					 * have no side effects, and therefore can be removed if the result is
					 * unused. Related issue: mishoo/UglifyJS2#2227
					 */
					pure_funcs: unsafe ?
						// https://stackoverflow.com/a/10756976
						Object.getOwnPropertyNames(Math).map(key => `Math.${key}`) :
						null,
					reduce_vars: true,
					/* Using sequences (a; b; c; -> a, b, c) provide any performance benefits,
					 * but it makes code harder to read. Therefore, this behaviour is disabled.
					 */
					sequences: false,
					toplevel: true,
					typeofs: false, // typeof foo == "undefined" -> foo === void 0: the former is more readable
					unsafe,
					unused: true,
				},
				output: {
					beautify: true,
					comments: true,
				},
			});
			if (result.error) {
				lib.error("Couldn't preprocess with uglify-js: " + JSON.stringify(result.error));
			} else {
				code = result.code;
			}
		}

		if (!argv["no-rewrite-prototype"]) {
			lib.info("    Replacing `function A.prototype.B()` (use --no-rewrite-prototype to skip)...", false);
			// Replace `function X.prototype.y()` with `X.prototype.y = function()`
			code = code.replace(/function (\w+)\.prototype\.(\w+)/gm, "$1.prototype.$2 = function");
		}

		let tree;
		try {
			tree = esprima.parse(code);
		} catch (e) {
			lib.error(e);
			lib.error("");
			if (filename.match(/jse$/)) {
				lib.error(
					`This appears to be a JSE (JScript.Encode) file.
Please compile the decoder and decode it first:

cc decoder.c -o decoder
./decoder ${filename} ${filename.replace(/jse$/, "js")}

`
				);
			} else {
				lib.error(
					`This doesn't seem to be a JavaScript/WScript file.
If this is a JSE file (JScript.Encode), compile
decoder.c and run it on the file, like this:

cc decoder.c -o decoder
./decoder ${filename} ${filename}.js

`
				);
			}
			process.exit(-1);
			return;
		}

		if (argv["function-rewrite"]) {
			lib.info("    Rewriting functions (remove --function-rewrite to skip)...", false);
			traverse(tree, function(key, val) {
				if (key !== "callee") return;
				if (val.autogenerated) return;
				switch (val.type) {
					case "MemberExpression":
						return require("./patches/this.js")(val.object, val);
					default:
						return require("./patches/nothis.js")(val);
				}
			});
		}

		if (!argv["no-typeof-rewrite"]) {
			lib.info("    Rewriting typeof calls (use --no-typeof-rewrite to skip)...", false);
			traverse(tree, function(key, val) {
				if (!val) return;
				if (val.type !== "UnaryExpression") return;
				if (val.operator !== "typeof") return;
				if (val.autogenerated) return;
				return require("./patches/typeof.js")(val.argument);
			});
		}

		if (!argv["no-eval-rewrite"]) {
			lib.info("    Rewriting eval calls (use --no-eval-rewrite to skip)...", false);
			traverse(tree, function(key, val) {
				if (!val) return;
				if (val.type !== "CallExpression") return;
				if (val.callee.type !== "Identifier") return;
				if (val.callee.name !== "eval") return;
				return require("./patches/eval.js")(val.arguments);
			});
		}

		if (!argv["no-catch-rewrite"]) { // JScript quirk
			lib.info("    Rewriting try/catch statements (use --no-catch-rewrite to skip)...", false);
			traverse(tree, function(key, val) {
				if (!val) return;
				if (val.type !== "TryStatement") return;
				if (!val.handler) return;
				if (val.autogenerated) return;
				return require("./patches/catch.js")(val);
			});
		}

		// console.log(JSON.stringify(tree, null, "\t"));
		code = escodegen.generate(tree);

		// The modifications may have resulted in more concatenations, eg. "a" + ("foo", "b") + "c" -> "a" + "b" + "c"
		if (argv["dumb-concat-simplify"]) {
			lib.info("    Simplifying \"dumb\" concatenations (remove --dumb-concat-simplify to skip)...", false);
			code = code.replace(/'[ \r\n]*\+[ \r\n]*'/gm, "");
			code = code.replace(/"[ \r\n]*\+[ \r\n]*"/gm, "");
		}

		lib.info("Rewritten successfully.", false);
	}

	return code;
}
code = rewrite(code);
lib.logJS(code);

Array.prototype.Count = function() {
	return this.length;
};

const sandbox = {
	ActiveXObject,
	alert: (x) => {},
	console: {
		log: (x) => lib.info("Script output: " + JSON.stringify(x)),
	},
	Enumerator: require("./emulator/Enumerator"),
	GetObject: require("./emulator/WMI").GetObject,
	JSON,
	location: new Proxy({
		href: "http://www.foobar.com/",
		protocol: "http:",
		host: "www.foobar.com",
		hostname: "www.foobar.com",
	}, {
		get: function(target, name) {
			switch (name) {
				case Symbol.toPrimitive:
					return () => "http://www.foobar.com/";
				default:
					return target[name.toLowerCase()];
			}
		},
	}),
	parse: (x) => {},
	rewrite: (code) => rewrite(lib.logJS(code)),
	ScriptEngine: () => {
		const type = "JScript"; // or "JavaScript", or "VBScript"
		lib.warn(`Emulating a ${type} engine (in ScriptEngine)`);
		return type;
	},
	_typeof: (x) => x.typeof ? x.typeof : typeof x,
	WScript: new Proxy({}, {
		get: function(target, name) {
			if (typeof name === "string") name = name.toLowerCase();
			switch (name) {
				case Symbol.toPrimitive:
					return () => "Windows Script Host";
				case "tostring":
					return "Windows Script Host";

				case "arguments":
					return new Proxy((n) => `${n}th argument`, {
						get: function(target, name) {
							switch (name) {
								case "Unnamed":
									return [];
								case "length":
									return 0;
								case "ShowUsage":
									return {
										typeof: "unknown",
									};
								case "Named":
									return [];
								default:
									return new Proxy(
										target[name],
										{
											get: (target, name) => name.toLowerCase() === "typeof" ? "unknown" : target[name],
										}
									);
							}
						},
					});
				case "createobject":
					return ActiveXObject;
				case "echo":
					if (argv["no-echo"])
						return () => {};
					return (x) => {
						lib.verbose("Script wrote: " + x);
						lib.verbose("Add flag --no-echo to disable this.");
					};
				case "path":
					return "C:\\TestFolder\\";
				case "sleep":
					// return x => console.log(`Sleeping for ${x} ms...`)
					return (x) => {};
				case "stdin":
					return new Proxy({
						atendofstream: {
							typeof: "unknown",
						},
						line: 1,
						writeline: (text) => {
							if (argv["no-echo"]) return;
							lib.verbose("Script wrote: " + text);
							lib.verbose("Add flag --no-echo to disable this.");
						},
					}, {
						get: function(target, name) {
							name = name.toLowerCase();
							if (!(name in target))
								lib.kill(`WScript.StdIn.${name} not implemented!`);
							return target[name];
						},
					});
				case "quit":
					return () => {};
				case "scriptfullname":
					return "(ScriptFullName)";
				case "scriptname":
					return "sample.js";
				default:
					lib.kill(`WScript.${name} not implemented!`);
			}
		},
	}),
	WSH: "Windows Script Host",
};

const vm = new VM({
	timeout: (argv.timeout || 10) * 1000,
	sandbox,
});

vm.run(code);

function ActiveXObject(name) {
	lib.verbose(`New ActiveXObject: ${name}`);
	name = name.toLowerCase();
	if (name.match("xmlhttp") || name.match("winhttprequest"))
		return require("./emulator/XMLHTTP");
	if (name.match("dom")) {
		return {
			createElement: require("./emulator/DOM"),
			load: (filename) => {
				// console.log(`Loading ${filename} in a virtual DOM environment...`);
			},
		};
	}

	switch (name) {
		case "adodb.stream":
			return require("./emulator/ADODBStream")();
		case "adodb.recordset":
			return require("./emulator/ADODBRecordSet")();
		case "scriptcontrol":
			return require("./emulator/ScriptControl");
		case "scripting.filesystemobject":
			return require("./emulator/FileSystemObject");
		case "scripting.dictionary":
			return require("./emulator/Dictionary");
		case "shell.application":
			return require("./emulator/ShellApplication");
		case "wscript.network":
			return require("./emulator/WScriptNetwork");
		case "wscript.shell":
			return require("./emulator/WScriptShell");
		case "wbemscripting.swbemlocator":
			return require("./emulator/WBEMScriptingSWBEMLocator");
		default:
			lib.kill(`Unknown ActiveXObject ${name}`);
			break;
	}
}

function traverse(obj, func) {
	const keys = Object.keys(obj);
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i];
		const replacement = func.apply(this, [key, obj[key]]);
		if (replacement) obj[key] = replacement;
		if (obj.autogenerated) continue;
		if (obj[key] !== null && typeof obj[key] === "object")
			traverse(obj[key], func);
	}
}
