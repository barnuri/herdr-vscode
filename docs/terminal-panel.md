# Terminals in the bottom panel

Like VS Code: the editor tab bar shows only editors (files, diffs, previews, Untitled, the empty
editor, mod views), and the bottom panel's Terminal view lists and shows every terminal.
Setting `terminal.inPanel` (default `true`); `terminal.scope` `"space"` (default) or `"all"`.

## Mechanism: a layout terminal block bound to any terminal

The panel's `term` block has `content: { "terminal": "<address>" }`. Herdr draws any live
terminal there, also one that has a pane in a tab, live and interactive. Nothing moves:
terminals stay in their tabs and spaces, so the Running view, agent status, attention and
other Herdr clients still see them.

- `pane.focus {terminal}` prefers the first visible layout terminal block, so after the
  panel shows a terminal, focus lands in the panel (`focused().pane` is null, `terminal` set).
- A tab is a *terminal tab* when it has terminal panes and no mod pane
  (`shared/terminal-core.js`). The tab bar, the tab list and the switcher hide these tabs.
- Redirect (herdr-vscode-panel, every 200 ms): when the active tab is a terminal tab (Running
  click, new terminal or agent from +, `tab.next`, space switch), the panel shows its focused
  terminal (else its agent), opens itself, selects the most recent editor tab (else opens the
  empty editor "Welcome"), then focuses the terminal in the panel.
- The list: terminal tabs' terminals of the space (or every space), in Herdr's order, then the
  panel's own shells (`hc run --label herdr-vscode.panel=1`, labelled with their space).
  Name: Rename's name, else the session title as in Running (program icon, no harness), else
  program · folder.
- ⌘W while a panel terminal has the keyboard closes no editor tab.
- Killing the last terminal tab of a space opens the empty editor first, so the space stays.

## Rejected: moving terminals (`terminal.park`)

`terminal.park` keeps the process (pid checked) but drops the `herdr.space`/`herdr.tab` labels
and core keep, removes the terminal from Running and agent status, and closes a space whose last
tab it was. Not needed, since a block can show a terminal in place.

## Limits

- The redirect is polled: a terminal tab can flash in the editor for up to 200 ms.
- Tabs that mix a terminal with a mod pane stay editor tabs; their terminals are not listed.
- Keyboard focus moves to the panel only while the panel is visible (the redirect opens it).
- Split shows two listed terminals side by side, as before.

## Maximized panel gives way to the editor

When the panel is maximized and the editor's tab or its file/diff viewer changes (Explorer,
Quick Open, Source Control, search, links, `hv`), the panel goes back to its saved
`panel.height`, as the restore (⌄) button does. One watch in herdr-vscode-panel covers every
opener; `panel.height` is not written.
