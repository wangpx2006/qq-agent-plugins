# QQ-agent 外挂三件套

给 [QQ-agent](https://github.com/Kondius/qq-agent)（MIT）加三个插件：

| 插件 | 解决什么 |
| --- | --- |
| `claude-bridge` | 让指定的私聊 / 群聊改由本机的 `claude` CLI 回，于是它有了记忆、能读写文件、能查东西。顺带负责**语气**。 |
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
- 没有 shell、没有写文件权限，只有 `Read / Grep / Glob`；
- 谁问密码、令牌、凭据都不给。

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

---

## 改语气

看 [docs/语气调校.md](docs/语气调校.md)。一句话版本：**别写形容词，写能执行的东西。**

---

## License

MIT。三个插件是本仓库新增的代码；宿主程序 QQ-agent 由 Kondius 以 MIT 发布，本项目没有改动它的源码。
