# jupyter-inspector

Introspect the expression under the cursor with a Jupyter kernel.

The kernel already knows what a name is bound to, what a function's signature looks like and what its docstring says. This asks it, and shows the answer in a dock panel next to the code.

## Features

- **Ask about the cursor**: introspects whatever the cursor sits in — a name, a dotted path, a subscript or a call.
- **Ask about anything else**: an expression field takes any expression, so a lookup does not have to be typed into the buffer first.
- **Evaluates first**: an expression a kernel cannot introspect directly, like `df.head()`, is bound to a temporary name and introspected there, then discarded.
- **Theme-true answers**: shows the kernel's plain-text help with its ANSI colours mapped to the editor theme.
- **Any kernel**: non-Python kernels are asked about the expression as written.
- **Remembers per kernel**: every kernel keeps its last inspection and the panel swaps with the active editor's kernel; a kernel that goes away takes its result along.

## Installation

To install `jupyter-inspector` search for _jupyter-inspector_ in the Install pane of the Lumine settings or run `lumine --install lumine-code/jupyter-inspector`.

It reads its kernels from [`jupyter-repl`](https://github.com/lumine-code/jupyter-repl), which needs to be installed too.

## Commands

Commands available in `atom-workspace`:

- `jupyter-inspector:toggle`: open the inspector, or return focus to the editor when it already has it,
- `jupyter-inspector:inspect`: introspect the expression under the cursor, revealing the panel when it is hidden.

Commands available in `.jupyter-inspector`:

- `jupyter-inspector:focus-expression`: move focus to the expression field,
- `jupyter-inspector:focus-body`: move focus to the result,
- `jupyter-inspector:scroll-up`: scroll the result up,
- `jupyter-inspector:scroll-down`: scroll the result down.

## Usage

The expression field is a real editor, so it gets the kernel's grammar and, with `autocomplete-plus` installed, its completions. Confirming it runs the lookup again; clearing it leaves the last result on screen.

Introspecting from the editor does not move focus, so a lookup can be read without losing the place in the code.

## Customization

Paste this into your `styles.css` to give the result more room to breathe:

```css
.jupyter-inspector {
  .inspector-body {
    padding: 0.5em;
    line-height: 1.6;
  }
}
```

## Services

- **jupyter.kernel** (`^1.0.0`): consumed to read the active kernel and ask it to introspect an expression.
- **autocomplete.watch-editor** (`^1.0.0`): consumed to offer completions in the expression field.
- **jupyter.output** (`^1.0.0`): consumed to colour and truncate the ANSI help text; without it the colour escapes are stripped.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
