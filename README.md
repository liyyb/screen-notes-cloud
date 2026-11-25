# 屏幕笔记 Cloud

Windows 屏幕截图笔记，支持 OCR、页面陪伴、笔记库和实时字幕。

## 下载体验

从 [GitHub Releases](https://github.com/liyyb/screen-notes-cloud/releases/latest) 下载 `screen-notes-cloud-v0.2.0-windows.zip`，完整解压后双击 `启动屏幕笔记.bat`。适用于 Windows 10/11 x64。中文 OCR 需系统安装对应语言包，笔记库使用系统 WebView2 Runtime。

体验包内置中文流式字幕组件，可在设置中切换云端转写。云端功能使用你自行填写的 API 配置。文本 API 未配置时，手动截图仍可使用 OCR 和抽取式摘要。

- 点击悬浮窗的「记录」或按 Ctrl+Alt+N 保存截图笔记。
- 双击悬浮窗或托盘图标打开笔记库，可分区、检索与导出。
- 使用托盘菜单退出后台服务。用户数据在运行后写入项目的 `data/`。

## 源码开发

使用支持 `node:sqlite` 的 Node.js（建议 22.13 或更新版本）。执行 `npm ci` 和 `npm run build` 后双击启动脚本。音频采集辅件和 WebView2 SDK 组件随源码提供，便携 Node 和本地语音模型随体验包提供。需要本地字幕时，可在设置中安装所需组件。

执行 `npm run test:contract` 和 `npm run test:migration` 验证接口契约与数据库迁移。
