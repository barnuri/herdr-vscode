# vx-status (Claude Code plugin)

The Claude Code half of the `vx-status` bar in the Herdr app. Inside a Herdr terminal
(`HC_TERMINAL_ID` set) it writes the session's model, effort, context window and usage meters
(`ctx`, `5h`, `7d`) to `~/.local/state/vx-status/<terminal>.json` when a session starts, a turn
completes, and usage is measured. The bar watches that folder.

It writes nothing else: no prompt or response text, no git calls, and nothing drawn in Claude
Code's own window. Outside Herdr it does nothing. Restart Claude Code sessions after installing.
