/**
 * CMake Tools extension for Visual Studio Code
 *
 * The module 'vscode' contains the VS Code extensibility API
 * Import the module and reference it with the alias vscode in your code below
 */

import { spawn } from "child_process";
import opener from 'opener'; // This requires esModuleInterop to be enabled in 'tsconfig.json'
import {
    CancellationToken,
    CompletionItem,
    CompletionItemKind,
    CompletionItemProvider,
    Disposable,
    DocumentSelector,
    Hover, HoverProvider,
    Position,
    SnippetString,
    TextDocument,
    commands,
    languages,
    window,
    workspace
} from 'vscode';

/// strings Helpers
function strContains(word: string, pattern: string): boolean {
    return word.indexOf(pattern) > -1;
}

function strEquals(word: string, pattern: string): boolean {
    return word == pattern;
}

/// configuration helpers
function config<T extends object | string>(key: string, defaultValue: T): T {
    const cmake_conf = workspace.getConfiguration('cmake');
    return cmake_conf.get<T>(key, defaultValue);
}

// copied from https://stackoverflow.com/questions/13796594/how-to-split-string-into-arguments-and-options-in-javascript
function commandArgs2Array(text: string): string[] {
    const re = /^"[^"]*"$/; // Check if argument is surrounded with double-quotes
    const re2 = /^([^"]|[^"].*?[^"])$/; // Check if argument is NOT surrounded with double-quotes

    let arr: string[] = [];
    let argPart: string | null = null;

    text && text.split(" ").forEach(function (arg: string) {
        if ((re.test(arg) || re2.test(arg)) && !argPart) {
            arr.push(arg);
        } else {
            argPart = argPart !== null ? argPart + " " + arg : arg;
            // If part is complete (ends with a double quote), we can add it to the array
            if (/"$/.test(argPart)) {
                arr.push(argPart);
                argPart = null;
            }
        }
    });
    return arr;
}

/// Cmake process helpers


interface CMakeError extends Error {
    code?: string;
}

// Simple helper function that invoke the CMAKE executable
// and return a promise with stdout
function cmake(args: string[]): Promise<string> {
    return new Promise((resolve, reject): void => {
        let cmake_config = config<string>('cmakePath', 'cmake');
        let cmake_args = commandArgs2Array(cmake_config);
        let cmd = spawn(
            cmake_args[0],
            cmake_args
                .slice(1, cmake_args.length)
                .concat(args.map(arg => { return arg.replace(/\r/gm, ''); }))
        );
        let stdout: string = '';
        cmd.stdout.on('data', function (data) {
            var txt: string = data.toString();
            stdout += txt.replace(/\r/gm, '');
        });
        cmd.on("error", function (error: CMakeError) {
            if (error && error.code === 'ENOENT') {
                window.showInformationMessage('The "cmake" command is not found in PATH.  Install it or use `cmake.cmakePath` in the workspace settings to define the CMake executable binary.');
            }
            reject();
        });
        cmd.on('exit', function (result) {
            if (result !== null) {
                resolve(stdout);
            }
        });
    });
}


function _extractVersion(output: string): string {
    let re = /cmake\s+version\s+(\d+.\d+.\d+)/;
    let version: string | null = null;
    if (re.test(output)) {
        let result = re.exec(output);
        if (result !== null) {
            version = result[1];
        }
    }
    return version ?? '';
}

async function cmake_version(): Promise<string> {
    let cmd_output = await cmake(['--version']);
    let version = _extractVersion(cmd_output);
    return version;
}

// Return the url for the online help based on the cmake executable binary used
async function cmake_help_url() {
    let base_url = 'https://cmake.org/cmake/help';
    let version = await cmake_version();
    if (version.length > 0) {
        if (version >= '3.0') {
            let re = /(\d+.\d+).\d+/;
            version = version.replace(re, '$1/');
        } else {
            let older_versions = [
                '2.8.12', '2.8.11', '2.8.10', '2.8.9', '2.8.8', '2.8.7', '2.8.6', '2.8.5', '2.8.4', '2.8.3', '2.8.2', '2.8.1', '2.8.0', '2.6'
            ];
            if (older_versions.indexOf(version) == -1) {
                version = 'latest/';
            } else {
                version = version + '/cmake.html';
            }
        }
    } else {
        version = 'latest/';
    }
    return base_url + '/v' + version;
}


// return the cmake command list
async function cmake_help_command_list(): Promise<string> {
    return cmake(['--help-command-list']);
}

async function cmake_help_command(name: string): Promise<string> {
    const result = await cmake_help_command_list();
    if (result.indexOf(name) < 0) {
        throw new Error(`Failed to find command: ${name}`);
    }
    return cmake(['--help-command', name]);
}

function cmake_help_variable_list(): Promise<string> {
    return cmake(['--help-variable-list']);
}

async function cmake_help_variable(name: string): Promise<string> {
    const result = await cmake_help_variable_list();
    if (result.indexOf(name) < 0) {
        throw new Error(`Failed to find variable: ${name}`);
    }
    return cmake(['--help-variable', name]);
}

function cmake_help_property_list(): Promise<string> {
    return cmake(['--help-property-list']);
}

async function cmake_help_property(name: string): Promise<string> {
    const result = await cmake_help_property_list();
    if (result.indexOf(name) < 0) {
        throw new Error(`Failed to find variable: ${name}`);
    }
    return cmake(['--help-property', name]);
}

function cmake_help_module_list(): Promise<string> {
    return cmake(['--help-module-list']);
}

async function cmake_help_module(name: string): Promise<string> {
    const result = await cmake_help_module_list();
    if (result.indexOf(name) < 0) {
        throw new Error(`Failed to find variable: ${name}`);
    }
    return cmake(['--help-module', name]);
}

function cmake_help_all() {
    let promises = {
        'function': (name: string) => {
            return cmake_help_command(name);
        },
        'module': (name: string) => {
            return cmake_help_module(name);
        },
        'variable': (name: string) => {
            return cmake_help_variable(name);
        },
        'property': (name: string) => {
            return cmake_help_property(name);
        }
    };
    return promises;
}

async function cmake_online_help(search: string) {
    let url = await cmake_help_url();
    let v2x = url.endsWith('html'); // cmake < 3.0
    return Promise.all([
        cmCommandsSuggestionsExact(search),
        cmVariablesSuggestionsExact(search),
        cmModulesSuggestionsExact(search),
        cmPropertiesSuggestionsExact(search),
    ]).then(function (results) {
        var suggestions = Array.prototype.concat.apply([], results);

        if (suggestions.length == 0) {
            search = search.replace(/[<>]/g, '');
            if (v2x || search.length == 0) {
                opener(url);
            } else {
                opener(url + 'search.html?q=' + search + '&check_keywords=yes&area=default');
            }
        } else {
            let suggestion = suggestions[0];
            let type = cmakeTypeFromVsCodeKind(suggestion.kind);
            if (type == 'property') {
                if (v2x) {
                    opener(url);
                } else {
                    // TODO : needs to filter properties per scope to detect the right URL
                    opener(url + 'search.html?q=' + search + '&check_keywords=yes&area=default');
                }
            } else {
                if (type == 'function') {
                    type = 'command';
                }
                search = search.replace(/[<>]/g, '');
                if (v2x) {
                    opener(url + '#' + type + ':' + search);
                } else {
                    opener(url + type + '/' + search + '.html');
                }
            }
        }
    });
}

/**
 * This method is called when your extension is activated. activation is
 * controlled by the activation events defined in package.json
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function activate(_disposables: Disposable[] = []) {
    commands.registerCommand('cmake.onlineHelp', () => {
        // The code you place here will be executed every time your command is executed
        // Display a message box to the user
        var editor = window.activeTextEditor;
        if (!editor) {
            return; // No open text editor
        }
        let selection = editor.selection;
        let document = editor.document;
        let position = selection.start;
        let currentSelection = document.getText(selection);
        let wordAtPosition = document.getWordRangeAtPosition(position);
        let currentWord = currentSelection;

        if (wordAtPosition && wordAtPosition.start.character < position.character) {
            var word = document.getText(wordAtPosition);
            currentWord = word;
        }

        window.showInputBox({ prompt: 'Search on Cmake online documentation', placeHolder: currentWord }).then(function (result) {
            if (typeof result != 'undefined') { // Escape
                if (result.length === 0) { //
                    result = currentWord;
                }
                if (result != "") {
                    cmake_online_help(result);
                }
            }
        });
    });

    const CMAKE_LANGUAGE = 'cmake';
    const CMAKE_SELECTOR: DocumentSelector = [
        { language: CMAKE_LANGUAGE, scheme: 'file' },
        { language: CMAKE_LANGUAGE, scheme: 'untitled' },
    ];

    languages.registerHoverProvider(CMAKE_SELECTOR, new CMakeExtraInfoSupport());
    languages.registerCompletionItemProvider(CMAKE_SELECTOR, new CMakeSuggestionSupport());

    languages.setLanguageConfiguration(CMAKE_LANGUAGE, {
        indentationRules: {
            // ^(.*\*/)?\s*\}.*$
            decreaseIndentPattern: /^(.*\*\/)?\s*\}.*$/,
            // ^.*\{[^}"']*$
            increaseIndentPattern: /^.*\{[^}"']*$/
        },
        wordPattern: /(-?\d*\.\d\w*)|([^\`\~\!\@\#\%\^\&\*\(\)\-\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\?\s]+)/g,
        comments: {
            lineComment: '#'
        },
        brackets: [
            ['{', '}'],
            ['(', ')'],
        ],

        __electricCharacterSupport: {
            brackets: [
                { tokenType: 'delimiter.curly.ts', open: '{', close: '}', isElectric: true },
                { tokenType: 'delimiter.square.ts', open: '[', close: ']', isElectric: true },
                { tokenType: 'delimiter.paren.ts', open: '(', close: ')', isElectric: true }
            ]
        },

        __characterPairSupport: {
            autoClosingPairs: [
                { open: '{', close: '}' },
                { open: '(', close: ')' },
                { open: '"', close: '"', notIn: ['string'] },
            ]
        }
    });
}

/**
 * Show Tooltip on mouse over
 */
class CMakeExtraInfoSupport implements HoverProvider {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public provideHover(document: TextDocument, position: Position, _token: CancellationToken): Thenable<Hover> {
        let range = document.getWordRangeAtPosition(position);
        let value = document.getText(range);
        let promises = cmake_help_all();

        return Promise.all([
            cmCommandsSuggestionsExact(value),
            cmVariablesSuggestionsExact(value),
            cmModulesSuggestionsExact(value),
            cmPropertiesSuggestionsExact(value),
        ],).then(function (results) {
            var suggestions = Array.prototype.concat.apply([], results);
            if (suggestions.length == 0) {
                return null;
            }
            let suggestion: CompletionItem = suggestions[0];

            return promises[cmakeTypeFromVsCodeKind(suggestion.kind)](suggestion.label).then(function (result: string) {
                let lines = result.split('\n');
                lines = lines.slice(2, lines.length);
                let hover = new Hover({ language: 'md', value: lines.join('\n') });
                return hover;
            });
        });
    }
}

function vscodeKindFromCMakeCodeClass(kind: string): CompletionItemKind {
    switch (kind) {
        case "function":
            return CompletionItemKind.Function;
        case "variable":
            return CompletionItemKind.Variable;
        case "module":
            return CompletionItemKind.Module;
    }

    // TODO@EG additional mappings needed?
    return CompletionItemKind.Property;
}

function cmakeTypeFromVsCodeKind(kind?: CompletionItemKind): string {
    switch (kind) {
        case CompletionItemKind.Function:
            return "function";
        case CompletionItemKind.Variable:
            return "variable";
        case CompletionItemKind.Module:
            return "module";
    }
    return "property";
}

function suggestionsHelper(
    cmake_cmd: Promise<string>,
    currentWord: string, type: string,
    insertText: null | string | ((p: string) => string),
    matchPredicate: (l: string, p: string) => boolean
): Thenable<CompletionItem[]> {
    return new Promise(function (resolve, reject) {
        cmake_cmd.then(function (stdout: string) {
            let commands = stdout.split('\n').filter(function (v: string) { return matchPredicate(v, currentWord) });
            if (commands.length > 0) {
                let suggestions = commands.map(function (command_name: string) {
                    var item = new CompletionItem(command_name);
                    item.kind = vscodeKindFromCMakeCodeClass(type);
                    if (typeof insertText === 'string') {
                        item.insertText = command_name;
                    } else if (typeof insertText === 'function') {
                        let snippet = new SnippetString(insertText(command_name));
                        item.insertText = snippet;
                    }
                    return item;
                });
                resolve(suggestions);
            } else {
                resolve([]);
            }
        }).catch(function (err: Error) {
            reject(err);
        });
    });
}

function cmModuleInsertText(module: string) {
    if (module.indexOf('Find') == 0) {
        return 'find_package(' + module.replace('Find', '') + '${1: REQUIRED})';
    } else {
        return 'include(' + module + ')';
    }
}

function cmFunctionInsertText(func: string): string {
    let scoped_func = ['if', 'function', 'while', 'macro', 'foreach'];
    let is_scoped = scoped_func.reduceRight(function (prev, name) { return prev || func == name; }, false);
    return is_scoped
        ? func + '(${1})\n\t\nend' + func + '(${1})\n'
        : func + '(${1})';
}

function cmVariableInsertText(variable: string): string {
    return variable.replace(/<(.*)>/g, '${1:<$1>}');
}

function cmPropertyInsertText(variable: string): string {
    return variable.replace(/<(.*)>/g, '${1:<$1>}');
}

function cmCommandsSuggestions(currentWord: string): Thenable<CompletionItem[]> {
    let cmd = cmake_help_command_list();
    return suggestionsHelper(cmd, currentWord, 'function', cmFunctionInsertText, strContains);
}

function cmVariablesSuggestions(currentWord: string): Thenable<CompletionItem[]> {
    let cmd = cmake_help_variable_list();
    return suggestionsHelper(cmd, currentWord, 'variable', cmVariableInsertText, strContains);
}


function cmPropertiesSuggestions(currentWord: string): Thenable<CompletionItem[]> {
    let cmd = cmake_help_property_list();
    return suggestionsHelper(cmd, currentWord, 'property', cmPropertyInsertText, strContains);
}

function cmModulesSuggestions(currentWord: string): Thenable<CompletionItem[]> {
    let cmd = cmake_help_module_list();
    return suggestionsHelper(cmd, currentWord, 'module', cmModuleInsertText, strContains);
}

function cmCommandsSuggestionsExact(currentWord: string): Thenable<CompletionItem[]> {
    let cmd = cmake_help_command_list();
    return suggestionsHelper(cmd, currentWord, 'function', cmFunctionInsertText, strEquals);
}

function cmVariablesSuggestionsExact(currentWord: string): Thenable<CompletionItem[]> {
    let cmd = cmake_help_variable_list();
    return suggestionsHelper(cmd, currentWord, 'variable', cmVariableInsertText, strEquals);
}


function cmPropertiesSuggestionsExact(currentWord: string): Thenable<CompletionItem[]> {
    let cmd = cmake_help_property_list();
    return suggestionsHelper(cmd, currentWord, 'property', cmPropertyInsertText, strEquals);
}

function cmModulesSuggestionsExact(currentWord: string): Thenable<CompletionItem[]> {
    let cmd = cmake_help_module_list();
    return suggestionsHelper(cmd, currentWord, 'module', cmModuleInsertText, strEquals);
}

class CMakeSuggestionSupport implements CompletionItemProvider {
    public excludeTokens: string[] = ['string', 'comment', 'numeric'];

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public provideCompletionItems(document: TextDocument, position: Position, _token: CancellationToken): Thenable<CompletionItem[]> {
        let wordAtPosition = document.getWordRangeAtPosition(position);
        var currentWord = '';
        if (wordAtPosition && wordAtPosition.start.character < position.character) {
            var word = document.getText(wordAtPosition);
            currentWord = word.substr(0, position.character - wordAtPosition.start.character);
        }

        return new Promise(function (resolve, reject) {
            Promise.all([
                cmCommandsSuggestions(currentWord),
                cmVariablesSuggestions(currentWord),
                cmPropertiesSuggestions(currentWord),
                cmModulesSuggestions(currentWord)
            ]).then(function (results) {
                var suggestions = Array.prototype.concat.apply([], results);
                resolve(suggestions);
            }).catch(err => { reject(err); });
        });
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public resolveCompletionItem(item: CompletionItem, _token: CancellationToken): Thenable<CompletionItem> {
        let promises = cmake_help_all();
        let type = cmakeTypeFromVsCodeKind(item.kind);
        return promises[type](item.label).then(function (result: string) {
            item.documentation = result.split('\n')[3];
            return item;
        });
    }
}

// CMake Language Definition

// class CMakeLanguageDef  /*implements LanguageConfiguration*/ {
//         public comments = {
// 			lineComment: '#',
// 		}
//         public name:string = 'cmake';
//         public displayName:string= 'Cmake';
//         public ignoreCase: boolean = true;
//         public lineComment: string = '#';
//         public autoClosingPairs:string[][] = [
//             ['{', '}'],
//             ['"', '"']];
//        public keywords :string[] = [
//            'if', 'endif', 'else',
//            'foreach', 'endforeach',
//            'function', 'endfunction',
//            'macro', 'endmacro',
//            'include',
//            'set',
//            'project'
//        ];
//         public brackets = [
//             { token: 'delimiter.parenthesis', open: '(', close: ')' },
//         ];
//         public textAfterBrackets:boolean = true;
//         public variable= /\$\{\w+\}/;
//        public  enhancedBrackets = [
//             {
//                 openTrigger: '\)',
//                 open: /if\((\w*)\)/i,
//                 closeComplete: 'endif\($1\)',
//                 matchCase: true,
//                 closeTrigger: '\)',
//                 close: /endif\($1\)$/,
//                 tokenType: 'keyword.tag-if'
//             },
//             {
//                 openTrigger: '\)',
//                 open: /foreach\((\w*)\)/i,
//                 closeComplete: 'endforeach\($1\)',
//                 matchCase: true,
//                 closeTrigger: '\)',
//                 close: /endforeach\($1\)$/,
//                 tokenType: 'keyword.tag-foreach'
//             },
//             {
//                 openTrigger: '\)',
//                 open: /function\((\w+)\)/i,
//                 closeComplete: 'endfunction\($1\)',
//                 matchCase: true,
//                 closeTrigger: '\)',
//                 close: /function\($1\)$/,
//                 tokenType: 'keyword.tag-function'
//             },
//             {
//                 openTrigger: '\)',
//                 open: /macro\((\w+)\)/i,
//                 closeComplete: 'endmacro\($1\)',
//                 matchCase: true,
//                 closeTrigger: '\)',
//                 close: /macro\($1\)$/,
//                 tokenType: 'keyword.tag-macro'
//             }
//         ];

//         // we include these common regular expressions
//         public symbols = /[=><!~?&|+\-*\/\^;\.,]+/;
//         public escapes= /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/;
//         // The main tokenizer for our languages
//         public tokenizer= {
//             root: [
//                 [/([a-zA-Z_]\w*)( *\()/,  [{cases: { '@keywords': { token: 'keyword.$0' } , '@default': 'identifier.method'}}, '']],
//                 { include: '@whitespace' },
//                 [/\$\{\w+\}/, 'variable'],
//                 [/\d*\.\d+([eE][\-+]?\d+)?/, 'number.float'],
//                 [/0[xX][0-9a-fA-F_]*[0-9a-fA-F]/, 'number.hex'],
//                 [/\d+/, 'number'],
//                 [/"/, 'string', '@string."'],
//                 [/'/, 'string', '@string.\''],
//             ],
//             whitespace: [
//                 [/[ \t\r\n]+/, ''],
//                 [/#.*$/, 'comment'],
//             ],
//             string: [
//                 [/[^\\"'%]+/, { cases: { '@eos': { token: 'string', next: '@popall' }, '@default': 'string' } }],
//                 [/@escapes/, 'string.escape'],
//                 [/\\./, 'string.escape.invalid'],
//                 [/\$\{[\w ]+\}/, 'variable'],
//                 [/["']/, { cases: { '$#==$S2': { token: 'string', next: '@pop' }, '@default': 'string' } }],
//                 [/$/, 'string', '@popall']
//             ],
//         };
//     }