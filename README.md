# stephen-ai

DeepSeek Harness (`dsh`) plugins by [StephenXiong001](https://github.com/StephenXiong001).

| Plugin | What it does |
|---|---|
| [dsh-task-mode-switch](dsh-task-mode-switch) | Switch a task's Agent preset (mode) from the composer toolbar, including tasks that have already started, plus AUTO, which picks one from the task text. |

## Install

```sh
# from npm (after the release)
dsh plugin --profile desktop add dsh-task-mode-switch

# from this repository
dsh plugin --profile desktop add "git+https://github.com/StephenXiong001/stephen-ai.git#main&path:/dsh-task-mode-switch"
```

Each plugin directory is a standalone npm package that declares a `dsh.bundle`
manifest, so `dsh plugin add` installs it as an installable Harness bundle.
See that plugin's README for usage, caveats and verification status.

## License

MIT. See [LICENSE](LICENSE).
