# 嗨番 MCP

嗨番 MCP 是面向 Kimi Work 和本机 Pi Web 的共享工具集合，后续可以按版本增加通用能力。当前首期只有图像诊断，工具名 `diagnose_image` 意为“诊断图片”，不代表整个 MCP 的名称。模型只传图片路径，适配器读取图片并发送字节；服务凭证留在本机连接程序中。

本仓库是客户端分发包。诊断服务由 HiFun 管理员运行；安装本插件不会在你的电脑上部署胶囊，也不需要云端密钥。需要 Node.js 22.19 或以上；仓库自带构建产物，使用者无需运行 `npm install`。

## 在 Kimi Work 安装

将以下仓库链接交给 Kimi Work 的 Plugin Builder，要求导入并安装「嗨番 MCP」：

https://github.com/woshiyjy/HiFun_MCP_Plugins

原生清单在根目录 `kimi.plugin.json`；插件只声明一个 stdio MCP 和一个 Skill。Kimi Work 官方导入流程见[创建个人插件](https://www.kimi.com/help/plugins-and-skills/create)。如果客户端支持原生插件安装命令，也可以使用仓库 URL；实际入口以你的 Kimi Work 版本为准。

安装后，请找到插件安装目录，在**你自己的终端**运行：

```sh
node bundle/bridge.mjs --configure
node bundle/bridge.mjs --check
```

按提示填写图片目录和管理员单独发给你的调用凭证。凭证输入不显示，不要在 Kimi 对话中粘贴凭证或让模型代读配置。HTTPS 服务地址默认已填好。`--check` 只验证 Tool 和 Skill，不上传图片、不产生诊断调用。

安装、连接配置、图片诊断是三个分别验收的步骤。首次使用前请保证 Kimi Work 进程能在 PATH 找到 Node.js。找不到时，将 MCP 配置中的 `command` 改为本机 Node 的绝对路径。

## 在本机 Pi Web 安装

将仓库下载/克隆到固定目录。在该目录的终端运行：

```sh
node bundle/bridge.mjs --configure
node bundle/bridge.mjs --check
node bundle/bridge.mjs --install-pi
```

安装器向标准 `~/.pi/agent/mcp.json` 合并一个 `hifun_mcp` 条目，并安装本地兼容 Skill；保留既有条目，已有同名项时停止。适用于使用标准 Agent 目录的 Pi/Pi Web。如果 Pi Web 设置了独立 `PI_CODING_AGENT_DIR`，请在该实例的 MCP 设置中导入 [配置示例](examples/pi-mcp.json)，替换安装路径，并将本插件 Skill 加入该实例的 Skill 目录。

在 Pi Web 的 MCP 管理界面检查连接，重新加载或新建会话后测试。命令行 Pi 与 Pi Web 的 Runtime 版本可能不同，`pi mcp list` 通过只证明连接层，不代表浏览器会话已验收。

## 提供图片并测试

1. 将本次要诊断的番茄图片保存/上传到你在配置时选择的图片目录。只接受 JPEG、PNG、WebP，单张不超过 8 MiB；服务端还会校验像素上限及真实解码。
2. 向 Agent 提供该文件的绝对路径，并明确要求使用 HiFun MCP 进行症状评估。仅有聊天中的图片预览、不存在可读取路径时，需要先保存图片。
3. 工具参数只有 `image_path`，不要把图片转成 Base64 粘贴到聊天。结果中的 `source.transport=MCP` 标明调用方式，`source.cached` 标明是否复用本机结果。

同一图片不会自动重复提交。超时或结果不明时，本机保留状态并停止重试；由管理员核对后，如果用户明确决定重新提交，可在终端运行：

```sh
node bundle/bridge.mjs --reset-image /ABSOLUTE/PATH/image.jpg --confirmed
```

该操作允许一次新的诊断，可能产生新的服务费用；不能由 Agent 用来绕过未知状态。改变连接身份前先核对未确认记录。

标准通道只表示胶囊给出了图像范围/证据，不代表完成疾病确诊。主 Agent 应结合原图、可信资料与补充信息回答，保留不确定性、补图请求及安全阻断。

## 更新与卸载

v0.1.1 将整体名称改为“嗨番 MCP”，连接标识改为 `hifun_mcp`；诊断工具仍叫 `diagnose_image`，专门的图像诊断 Skill 名称保持不变。

若已经安装 v0.1.0：请在宿主设置中将原 `hifun_diagnosis` MCP 条目重命名为 `hifun_mcp`，保留原命令、参数和连接配置；Kimi Work 若不支持改名，请移除旧插件后导入新版，避免同时启用两份。无需重新配置本机凭证或清空调用状态。Pi 安装器发现旧条目会停止，请勿重复添加。

更新插件后重新加载宿主。远程 Skill 通过正式 list/get/read 流程和 SHA256 验证，最长缓存五分钟；版本与本插件绑定的摘要不一致时，诊断停止并要求更新。宿主使用仓库中的本地兼容 Skill，这不表示 Kimi Work 或 Pi Web 已原生实现 MCP Skills 扩展自动激活。

在宿主的插件/MCP 管理页停用或删除 `hifun_mcp` 即可停止调用；Pi 安装器加入的 Skill 名为 `hifun-image-diagnosis`。本机连接配置和调用状态在 `~/.config/hifun-mcp`，不会随公开插件分发。先核对待处理诊断，再决定是否删除本机状态；请勿直接打印其内容。

## 开发与验证

```sh
npm ci --ignore-scripts
npm run check
```

测试只使用合成像素图片及离线替身。`bundle/bridge.mjs` 为自包含 Node.js 程序；`bundle/SHA256SUMS` 记录构建摘要。更新服务端公开 Skill 时，同步 `server-SKILL.md`、`skill-source.json` 和兼容 Skill，再重新构建、测试、发布版本。

当前验收范围见 [验证记录](VALIDATION.md)。Kimi Work 的实际 GitHub 导入和真实图片效果，需要在使用者的客户端分别验收；不能用本仓库测试替代。
