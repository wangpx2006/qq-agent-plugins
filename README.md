# QQ-agent 外挂三件套

给 [QQ-agent](https://github.com/Kondius/qq-agent)（MIT）加三个插件：

| 插件 | 解决什么 |
| --- | --- |
| `claude-bridge` | 让指定的私聊 / 群聊改由本机的 `claude` CLI 回，于是它有了记忆、能读写文件、能查东西、能看图和语音。顺带负责**语气**，还负责**省 token**（会话复用 + 用量记账）。 |
| `voice-transcribe` | 语音消息转成文字再交给模型（本地 faster-whisper，离线）。 |
| `sticker-send-as-emoji` | 机器人发的表情终于显示成「表情」，不再是一张撑满气泡的大图。 |

这三个都是**外挂**，不改 `src/` 一行代码，所以应用升级不会被冲掉，卸载即恢复原样。

如果你只是想让机器人说话别那么像客服，直接跳到 [docs/语气调校.md](docs/语气调校.md)，那个不用装任何东西。

---

## 它长什么样

私聊里它会：

- 一条 3~15 个字，想到什么拆成几条发，不是一段话；
- 不打句号、不分点、不总结、不升华、不问你「吃饭了吗」；
- 有口头禅，但不会每句都挂；
- 听不懂会说听不懂，不会编；
- 能翻本机的笔记和记忆，能跑命令干活，干不了会说干不了。

群聊里它会：

- 只接自己在乎的话题，别人聊得热闹就听着（回 `PASS`，不发出去）；
- 没 @ 它、话里也没带它的名字时，自己判断接不接；
- 没有 shell、没有写文件权限，只有 `Read / Grep / Glob`；
- 谁问密码、令牌、凭据都不给，包括熟人；能看图、能听语音，也能上网搜。

---

## 省 token：会话复用

这是这套插件里最值钱的一块，值得单独说。

**问题**：`claude -p` 每跑一次都是全新进程，十几 k 的固定前缀（系统提示 + 工具定义 + 历史）每次都当新输入计费。上下文缓存写着「命中省 90%」，可前缀对不上就一次都命中不了，实测一直是 0。

**做法**：同一个聊天固定一个会话 id（`--session-id` 建、`--resume` 续），前缀从此一字不差，缓存才真的开始命中。实测同一轮对话：

| | 输入 token | 其中命中缓存 | 命中率 |
| --- | --- | --- | --- |
| 第一轮 | 13124 | 0 | 0% |
| 第二轮 | 17396 | 13056 | **75.1%** |

按 DeepSeek 闲时价算，那一轮从 ¥0.0175 掉到 ¥0.0049。聊得越久命中越高，稳定在 75%~99%。

**什么时候自动重开会话**：上下文涨到 10 万 token（再便宜，每轮把十万 token 过一遍也慢）、闲置超过 8 小时、或者撞上 CLI 的会话上限。重开的那一轮会变慢变贵，之后就又便宜了。

**用量在哪看**：每轮的 token 都写进 `data/sessions/`，面板的用量页直接读它，峰谷两个时段分开记账。

---

## 安装

前提：QQ-agent 已经能正常收发消息。三个插件互相独立，可以只装其中一个。

1. 把 `plugins/` 下要用的目录**整个复制**到 QQ-agent 的 `plugins/` 目录里。
2. 重启 QQ-agent（或用插件面板重新加载）。
3. 打开插件设置，填下面这几项。

### claude-bridge 要填的

| 配置项 | 说明 |
| --- | --- |
| `ownerIds` | 接管谁的私聊，填 QQ 号数组。**空着就谁都不接管。** |
| `groupIds` | 要接管的群号数组，不填就不进群聊。 |
| `selfUin` | 机器人自己的 QQ 号，用来认出「@ 的是我」和「这条是我发的」。 |
| `botNames` | 它在群里被叫的名字，比如 `["小助手"]`。 |
| `claudeCmd` | 留空会自动找 `%USERPROFILE%\AppData\Roaming\npm\claude.cmd`。 |
| `systemPromptFile` | 可选。填了就整段替换 CLI 默认的系统提示（`--system-prompt-file`），留空用默认。 |
| `memoryDirs` | 可选。群里允许它翻的目录，留空用插件自己的 `data\memory`。 |
| `searchMcp` / `searchNode` | 可选。搜索 MCP 脚本路径、跑它的 node；留空按常见位置猜，猜不到就不挂搜索（`web_search` 那两句也就失效了）。 |
| `fetchFileScript` | 可选。QQ 的文件消息只带消息号，填一个「传消息号、打印本地路径」的脚本，它才读得了别人发的文件。 |
| `cronScript` / `cronTime` / `cronNode` | 可选。每天定时跑一个脚本，比如 `cronScript` 填绝对路径、`cronTime` 填 `20:00`，留空不启用。 |

前提是本机装了 [Claude Code](https://claude.com/claude-code) 并且 `claude` 命令能用、已经登录。

### voice-transcribe 要额外做的

```bash
cd plugins/voice-transcribe
pip install -r requirements.txt
```

模型第一次用会自己下载（`small` 约 480MB，走 hf-mirror 国内镜像）。会落在 `data/asr-models/`，**别放插件目录里**——原因见「踩过的坑」。

### sticker-send-as-emoji

装上就行，没有要配的。

---

## 踩过的坑

这些都是真的踩出来的，省得你再踩一遍。

**模型文件不能放 `plugins/` 里。** 应用用 `fs.watch` 递归监听插件目录，模型一落盘就被当成「插件代码变了」，然后不停重载，识别服务被反复杀掉。所以 `asr_server.py` 把模型目录算到 `data/asr-models/`。

**`av` 必须锁 13.1.0。** `av` 19 和 `faster-whisper` 1.2.1 不兼容，报 `open() got an unexpected keyword argument 'metadata_errors'`。`requirements.txt` 里已经锁死了。

**走 HuggingFace 镜像要关 xet。** 新版 `huggingface_hub` 默认走 xet 加速，而镜像站不支持，会以 401 失败（`cas-server.xethub.hf.co`）。脚本里设了 `HF_HUB_DISABLE_XET=1`。

**Electron 起不来，先看看环境变量。** 如果 shell 里有 `ELECTRON_RUN_AS_NODE=1`，Electron 会当成 node 跑，报 `Cannot read properties of undefined (reading 'exports')`。启动前 `unset ELECTRON_RUN_AS_NODE`。

**群聊永远不给 `Bash`。** 私聊那头只有主人一个人，权限全开无所谓；群里还有别人，给了 shell 等于把电脑交出去。要联网也只加「搜索 / 抓网页」这种窄 MCP，别为了省事把 `Bash` 塞进 `GROUP_TOOLS`。

**缓存不是自动的。** 每轮都 spawn 新进程的话，前缀永远对不上，`cache_read_input_tokens` 会一直是 0。要省 token 必须复用会话，见上面那节。

**别拿 `process.execPath` 当 node 用。** 插件跑在 Electron 主进程里，那个值是 `electron.exe`，不是 `node`。要用 node 就写死路径或去常见安装目录找。

**插件里的未捕获异常会把 Electron 主进程带崩。** 用户看到的是一个报错弹框，然后机器人整个下线。所有回调（尤其是 `child.on('close')`）都要包一层 `try`，出错最多这一轮不回话。

---

## 改语气

看 [docs/语气调校.md](docs/语气调校.md)。一句话版本：**别写形容词，写能执行的东西。**

---

## License

MIT。三个插件是本仓库新增的代码；宿主程序 QQ-agent 由 Kondius 以 MIT 发布，本项目没有改动它的源码。
