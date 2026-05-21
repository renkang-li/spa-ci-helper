# SPA CI Helper

一个基于当前浏览器 GitLab 登录态的 Chrome 插件，用来批量打开 GitLab 页面、合并 MR 并触发集成发布 job，也可以根据项目 tag 触发 `upload-prod` 上传生产。

## 使用方式

1. 打开 Chrome 扩展程序页面：`chrome://extensions/`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本目录：`/home/lirenkang/projects/spa/spa-ci-helper`
5. 确认浏览器已经登录 `https://git.papamk.com`
6. 打开插件，选择执行模式
7. 合并 MR 模式：粘贴项目协作群里的 MR 链接文本
8. 上传生产模式：粘贴 tag 地址，或飞书模板发布列表，例如 `template-align-blog - v1.8.0|template-single-payment-page - v1.75.0`
9. 点击「解析」
10. 合并 MR 模式下，选择一个要触发的发布 job：`release-minor` 或 `release-patch`
11. 调试时保持「可视化执行」和「每步暂停 2 秒」开启，可以看到插件打开和切换页面
12. 点击「开始执行」

## 当前策略

- popup 解析 MR 链接，或解析 GitLab tag 链接 / 飞书模板发布列表。
- background 串行打开 GitLab 页面。
- background 通过 `chrome.scripting.executeScript` 在当前 GitLab 页面直接执行 DOM 操作。
- 合并 MR 流程通过当前登录态 API 只做查询：
  - 合并前预检 MR，已合并、冲突、非 opened 状态会跳过
  - 读取 MR 的 `merge_commit_sha`
  - 用 `merge_commit_sha` 查 master pipeline
  - 读取 pipeline jobs，拿到目标 job 页面链接
- 上传生产流程通过当前登录态 API 只做查询：
  - 读取 tag 信息和 commit sha
  - 用 tag ref 查 pipeline，优先匹配 tag commit sha
  - 读取 pipeline jobs，拿到 `upload-prod` 页面链接
  - 飞书发布列表只解析 `template-* - v*` 项，`spa-shop` / `spa-store` 等非模板项会忽略
  - 大多数模板映射到 `lf/minishops/templates/<template-name-without-template-prefix>`
  - `template-cleaner-blog`、`template-cleaner-product`、`template-single-payment-page` 映射到 `lf/minishops/<project-name>`
- 进入 job 页面后通过 DOM 点击页面上的执行按钮。

有副作用的动作走 DOM 点击；API 只用于查询和精确定位。

## 注意

- 当前版本默认串行处理，避免 GitLab 页面异步加载时互相干扰。
- 为了方便观察，执行标签页会前台打开；稳定后可以再改回后台静默执行。
- 执行完成后会保留标签页，方便人工查看最终 job 页面。
- 任务列表会显示当前 tab id 和 URL，可以点击「查看」切回正在执行的页面。
