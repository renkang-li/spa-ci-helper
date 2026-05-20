# SPA CI Helper

一个基于当前浏览器 GitLab 登录态的 Chrome 插件，用来批量打开 GitLab 页面、合并 MR，并在合并后触发 `release-minor` / `release-patch` 手动发布 job。

## 使用方式

1. 打开 Chrome 扩展程序页面：`chrome://extensions/`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本目录：`/home/lirenkang/projects/spa/spa-ci-helper`
5. 确认浏览器已经登录 `https://git.papamk.com`
6. 打开插件，粘贴项目协作群里的 MR 链接文本
7. 点击「解析」
8. 勾选要触发的发布 job
9. 点击「开始执行」

## 当前策略

- popup 解析 MR 链接。
- background 串行打开 MR 页面。
- content script 点击 GitLab 页面上的合并按钮。
- 合并后通过当前登录态 API 只做查询：
  - 读取 MR 的 `merge_commit_sha`
  - 用 `merge_commit_sha` 查 master pipeline
  - 读取 pipeline jobs 和 job 页面链接
- 进入 job 页面，通过 DOM 点击页面上的执行按钮。

有副作用的动作走 DOM 点击；API 只用于查询和精确定位。

## 注意

- 当前版本默认串行处理，避免 GitLab 页面异步加载时互相干扰。
- 为了方便观察，执行标签页会前台打开；稳定后可以再改回后台静默执行。
- 成功任务默认关闭标签页；失败任务会保留页面，方便人工查看。
- `chrome://extensions` 不能读取本地 markdown 文件，所以插件里的「读取 you-should-know」只是提醒，需要手动粘贴内容。
