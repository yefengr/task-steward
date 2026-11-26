# Pi 启动方式真机验证（V1、V3、V4）

本目录保留早期 Pi 启动预研（V1、V3、V4），不是当前启动器安装或验收入口。历史启动方式见[首版技术方案第 5.4 节](../../docs/plans/completed/20261112-initial-design.md#54-启动方式tmux-交互模式)，结果见该方案第 9.2 节；当前操作使用[部署与 Mac 接入](../../docs/DEPLOYMENT.md)。下面保留旧版探针参数，重跑前须核对当前 Pi 帮助，不为补记录重跑已完成验收。

| 文件 | 用途 |
| --- | --- |
| `probe-extension.ts` | 探针扩展：记录执行编号、会话标识与退出过程，并提供请求 Pi 正常退出的工具 `steward_probe_finish` |

所有命令都**在宿主机 macOS 的终端执行**，从本仓库根目录开始。验证会调用真实模型，消耗少量额度。

## 0. 准备

确认工具与参数。下面用到的参数是按 Pi 1.3.0 的官方文档核对的，Mac 上装的版本可能更新，先确认参数仍然存在：

```bash
tmux -V
pi --version
pi --help | grep -E -- '--session-id|--append-system-prompt|--approve|--extension|--name'
```

设置本次验证用的变量。V1、V3、V4 的启动、查询与清理全程使用测试专用 server `steward-test`（`-L "$SOCK"`），与正式启动器的 `steward` 及默认 tmux 隔离。开始前确认测试 server 中没有其他正在使用的会话；不要把 `$SOCK` 改为正式 server 名称。独立 server 不继承平时 tmux 会话里的环境变量。

```bash
export PROBE_EXT="$PWD/spikes/pi-launch/probe-extension.ts"
export PROJ=/tmp/steward-probe-project
export LOG=/tmp/steward-probe.log
export SOCK=steward-test
```

创建一次性测试项目。`AGENTS.md` 里放一条可观察的规则，用来判断项目配置是否加载：

```bash
rm -rf "$PROJ" "$LOG" && mkdir -p "$PROJ"
printf '# 测试项目规则\n\n每次回复的最后一行写「[项目规则已加载]」。\n' > "$PROJ/AGENTS.md"
git -C "$PROJ" init -q && git -C "$PROJ" add . && git -C "$PROJ" commit -qm init
```

确认手机或电脑上的 Pi Reach 已与这台 Mac 配对，Pi Reach 扩展像平时一样已经安装。

## V1：tmux 启动 Pi

模拟启动器领取任务后的启动命令。执行编号经环境变量传入，会话标识由启动器指定，首条消息就是任务指令：

```bash
tmux -L "$SOCK" new-session -d -s steward-probe-001 -c "$PROJ" \
  "env STEWARD_ATTEMPT_ID=probe-001 STEWARD_PROBE_LOG=$LOG pi -e '$PROBE_EXT' --session-id steward-probe-001 -n 'steward probe-001' '在项目根目录创建 hello.txt，内容为 hello，完成后告诉我。'"
```

等一两分钟后检查：

```bash
tmux -L "$SOCK" ls
tmux -L "$SOCK" capture-pane -p -t steward-probe-001 | tail -30
cat "$LOG"
cat "$PROJ/hello.txt"
```

| 检查项 | 通过标准 |
| --- | --- |
| 1-1 无人值守开工 | 没有任何人操作，`hello.txt` 已创建，内容为 `hello` |
| 1-2 项目规则加载 | 窗口内容里 Pi 的回复末尾有「[项目规则已加载]」 |
| 1-3 执行编号传入 | 日志 `session_start` 中 `attemptId` 为 `probe-001` |
| 1-4 会话标识生效 | 日志中 `sessionId` 为 `steward-probe-001`，并记下 `sessionFile` |
| 1-5 没有卡在确认界面 | 窗口里没有等待信任项目或其他确认的提示；如果有，记下提示内容，结束会话后在命令里加 `-a` 重试，并记录是否需要 `-a` |
| 1-6 Pi Reach 可对话 | 在 Pi Reach 中找到名为「steward probe-001」的会话，发送「hello.txt 里是什么？」，Pi 正常回答；`tmux -L "$SOCK" attach -t steward-probe-001` 进入后也能看到这轮对话，看完按 `Ctrl-b d` 退出，不要关闭窗口 |

可选：保持 V1 的会话运行，另开一个终端在任意项目里手动启动一个 Pi，确认 Pi Reach 能分别看到两个会话，并且互不干扰。

## V3：结束与退出

### 由 Pi 内部结束

在 Pi Reach（或接入 tmux 后）对该会话发送：

> 任务已完成，请调用 steward_probe_finish 工具结束。

然后检查：

```bash
tail -3 "$LOG"
tmux -L "$SOCK" has-session -t steward-probe-001; echo "has-session 退出码: $?"
pgrep -fl 'steward-probe-001' || echo '没有残留进程'
```

| 检查项 | 通过标准 |
| --- | --- |
| 3-1 Pi 正常退出 | 日志依次出现 `finish_requested`、`session_shutdown` |
| 3-2 tmux 会话随之结束 | `has-session` 退出码非 0 |
| 3-3 无残留进程 | 没有与 `steward-probe-001` 相关的进程 |

### 由启动器强制清理（兜底）

用一个新会话验证用户取消时的兜底路径：

```bash
tmux -L "$SOCK" new-session -d -s steward-probe-002 -c "$PROJ" \
  "env STEWARD_ATTEMPT_ID=probe-002 STEWARD_PROBE_LOG=$LOG pi -e '$PROBE_EXT' --session-id steward-probe-002 '列出项目里的文件，然后等待我的下一条消息。'"
# 等 Pi 回复完成后：
tmux -L "$SOCK" kill-session -t steward-probe-002
sleep 3
tail -3 "$LOG"
pgrep -fl 'steward-probe-002' || echo '没有残留进程'
```

| 检查项 | 通过标准 |
| --- | --- |
| 3-4 强制清理 | 关闭 tmux 会话后没有残留的 Pi 进程；记录日志中是否出现 `session_shutdown` |

## V4：返修恢复

在 V3 中 `steward-probe-001` 已经退出。用同一个会话标识重新启动，模拟返修：

```bash
tmux -L "$SOCK" new-session -d -s steward-probe-001-r1 -c "$PROJ" \
  "env STEWARD_ATTEMPT_ID=probe-001-r1 STEWARD_PROBE_LOG=$LOG pi -e '$PROBE_EXT' --session-id steward-probe-001 '返修：不要重新解释任务，直接把你之前创建的那个文件的内容改成 hello again。'"
```

等待完成后检查：

```bash
tail -2 "$LOG"
cat "$PROJ/hello.txt"
```

| 检查项 | 通过标准 |
| --- | --- |
| 4-1 回到原会话 | 新的 `session_start` 中 `sessionId` 仍为 `steward-probe-001`，`sessionFile` 与 V1 相同，`attemptId` 为 `probe-001-r1` |
| 4-2 保留原上下文 | Pi 不需要再问是哪个文件，`hello.txt` 内容变为 `hello again` |
| 4-3 Pi Reach 可继续 | Pi Reach 中该会话能看到之前的历史并继续对话 |

完成后优先让 Pi 调用 `steward_probe_finish` 结束本次测试会话。确需清理整个测试 server 时，先确认 `$SOCK` 仍为 `steward-test`，并用 `tmux -L "$SOCK" ls` 核对仅含本次创建的验证会话，再执行 `tmux -L "$SOCK" kill-server`。这会结束该测试 server 上的所有会话；不得用于正式 `steward`、默认 tmux 或其他会话。

## 补充：启动器环境下的 PATH

正式启动器由 LaunchAgent 托管，环境比终端精简。下列 P-1 保持使用另一个测试专用 socket `steward-minimal`；启动、查询和清理只针对该测试 server，执行前确认没有其他使用者。历史结果显示还需在 PATH 加入实际 Node 目录，按当前工具位置核对后再运行：

```bash
env -i HOME="$HOME" USER="$USER" PATH="$(dirname "$(command -v pi)"):/usr/bin:/bin:/usr/sbin:/sbin" \
  "$(command -v tmux)" -L steward-minimal new-session -d -s steward-probe-003 -c "$PROJ" \
  "env STEWARD_ATTEMPT_ID=probe-003 STEWARD_PROBE_LOG=$LOG pi -e '$PROBE_EXT' --session-id steward-probe-003 '回复「最小环境可用」。'"
sleep 20
"$(command -v tmux)" -L steward-minimal capture-pane -p -t steward-probe-003 | tail -15
"$(command -v tmux)" -L steward-minimal kill-server
```

| 检查项 | 通过标准 |
| --- | --- |
| P-1 最小环境可启动 | Pi 正常回复；如果报找不到 `node` 等命令，记下缺少的命令和所在目录 |

## 回报结果

把以下内容发给我，我写回方案第 9.2 节：

1. 每个检查项是否通过；未通过时附上窗口内容或报错。
2. `cat "$LOG"` 的完整输出。
3. `pi --version`、`tmux -V`，以及第 1-5 项是否需要 `-a`。

完成后可以删除测试项目：`rm -rf "$PROJ" "$LOG"`。
