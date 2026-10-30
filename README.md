# 阅卷助手 · 国内版

本目录维护 GitHub 的 `domestic-AI` 分支。它保留 PDF 答卷、逐题建议评分、独立模型复核、人工改分、费用账本、断点恢复及 CSV 导出。**不支持 GPT/OpenAI API**。

提供两种部署方式：**GitHub Pages 个人密钥版**与 **Node 服务器版**。Pages 发布入口为 [国内阅卷助手](https://ydhhhh.github.io/exam-grading-assistant/)，由本分支的 Actions 自动构建。**目前Pages 已上线；Node 服务器版未来可在北大 CLab 云主机部署并通过加密管理连接验收，正式校园域名与 HTTPS 尚待办理，因此暂无可分享的服务器版网址。** 服务器程序也支持负责人统一保管密钥及访问码登录。两者都不需要 ChatGPT 登录，字体、PDF.js 及转图资源均由本站提供。

GitHub Pages 不提供 Node 后端，个人密钥版在浏览器内验证请求并直连国内模型官方接口，不向 GitHub 上传密钥或答卷。`github.io` 能否在目标校园或运营商网络稳定访问仍须当地实测。

## 三阶段设置

| 步骤 | 默认服务商 | 默认模型 |
| --- | --- | --- |
| 整理评分规则 | Kimi | `kimi-k3.1-pro` |
| 姓名学号识别和逐题初评 | DeepSeek | `deepseek-flash` |
| 独立模型复核 | Kimi | `kimi-k3.1-pro` |

每个步骤都可选择 Kimi、DeepSeek、Qwen，并单独填写密钥；同一供应商可在不同步骤使用同一把或不同账户的密钥。Qwen 提供 `qwen3.8-max` 与 `qwen3.8-flash`。只列已核实的视觉模型及官方国内接口，不接受自定义转发地址。首次请求后锁定本批次三个步骤的模型、参数和费率，继续处理不会悄悄换模型。初评和复核必须使用不同模型。

Kimi K3.1 Pro、DeepSeek Flash 的图片能力及当前模型名称均已按官方资料核对；DeepSeek 已完成少量合成材料的真实 API 连通和初评测试，Kimi/Qwen 与手写卷评分仍待验收。Kimi K3.1 Pro 的账户开通要求以官方平台为准。

## 助教使用

1. 打开部署后的网址，先体验合成演示，不产生 API 费用。
2. 选择试题、参考答案、评分细则（PDF、PNG/JPEG/WebP、UTF-8 文本；Word 请先另存 PDF）。每份原件最多 3 MiB，三份合计最多 6 MiB。PDF 在浏览器转图，转图后超限须减小材料。
3. 在三个 API 卡片分别选择服务商、模型、密钥。默认手填模式只把密钥保留在当前页面内存；刷新后重新填写，进度和导出不含密钥。服务器版的负责人统一配置模式则先用访问码登录，Pages 版无需访问码。
4. 整理评分规则并人工核对题号、分值、评分点。“规则说明”不阻止确认；“待核对问题”须逐项处理。可展开“核对并修正规则”，在本机修改现有题目、评分点或政策，填写每条提示的处理依据及核对人，保存后再勾选最终确认。负责人可导出一份统一规则，其他助教导入，避免重复整理和规则漂移。
5. 每名学生一份 `学号.pdf`，若有 m 道题则严格 m+1 页：第 1 页姓名学号，第 2 至 m+1 页对应各题。选择答卷文件夹，先检查页数，再开始批改。首页身份图片与匿名作答分别发送。
6. 独立复核默认开启，只查看原作答及教师规则，不接收初评分数、理由或标记。按每道题比较两次得分：同分保留原分；不同且分差不超过 2 分，AI 建议分取平均后向上取整（例如 7/9→8、7/8→8），且不超过本题满分；分差超过 2 分再交人工。两份逐点评分和理由原样保留，不将合成的题分虚构分配到评分点。缺页、读不清、异常标记或未完成复核仍待处理。人工确认分始终优先，CSV 保留每题初评分、复核分和采用方式。已有备份恢复后按此规则重新计算 AI 建议，不改原始结果或已确认的人工分。
7. 保持网页打开，可暂停、下载进度备份、按学号查看改分或导出建议成绩。关闭页面不会继续后台执行；费用未定的调用不自动重发。

规则核对不会再次调用 API。程序仍校验满分、允许分档和评分依赖；缺少整题或评分点时须补充材料重新整理，或导入完整规则。未保存修改会撤销确认，刷新恢复后须重新确认。旧版提示不会自动变成普通说明。统一规则文件只含最终规则及确认人；建立批次后的进度备份另保留模型原始返回、费用和最近一次核对记录，建议及时下载。

国内版使用独立的浏览器存储及流水线版本，不加载标准版旧进度。Pages 与 Node 版也各自保存进度；服务器统一配置模式的备份可在 Pages 查看、人工确认和导出，但不能直接续跑付费请求，须保留原备份并新建个人密钥批次。升级前请保留旧站及备份，使用统一规则新建国内批次。学生材料、密钥、成绩、进度备份不进入 Git。正式成绩仍须教师或授权助教实质审阅确认，程序不连接教务系统。

## 本机启动与复现

需要 Node.js 22.13+ 和 npm。源码入口为 `app/`、`lib/grading/`；测试为 `tests/`。

```sh
npm ci
npm test
npm run typecheck
npm run build
npm start
```

启动后访问 `http://127.0.0.1:3000`。默认模式是 `test`，三个阶段各自手填密钥。开发使用 `npm run dev`。只检查就绪状态、不会调用模型的命令：

```sh
npm run check:deployment
```

生产结果位于 `.next/standalone/`，包括 Node 服务、前端及 PDF 资源。它是可重建产物，不提交到 Git。构建和安装需要从包仓库下载依赖，**网站运行时**无需访问 npm、GitHub、ChatGPT 或外部前端 CDN。

## GitHub Pages 部署与本机预览

[GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages) 仅托管静态文件。本分支构建时不包含服务器 API 路由；四个阅卷步骤复用相同的请求校验、结构化输出、费用核对和独立复核逻辑，由浏览器发送到固定的 Kimi、DeepSeek、Qwen 官方接口。

```sh
npm ci
npm test
npm run typecheck
npm run build:pages
npm run check:pages
npm run preview:pages
```

预览地址为 `http://127.0.0.1:3037/exam-grading-assistant/`。静态成品位于 `out/`，构建临时源码位于 `work/github-pages-build/`；原始 `app/api/` 及 Node 构建保持完整。`NEXT_PUBLIC_DEPLOYMENT_TARGET=github-pages` 仅选择部署方式，`NEXT_PUBLIC_BASE_PATH=/exam-grading-assistant` 只配置公开资源路径，任何密钥都不得写进 `NEXT_PUBLIC_*`。

本仓库 **Settings → Pages → Source** 选择 **GitHub Actions**；**Settings → Environments → github-pages → Deployment branches and tags** 限定为 `domestic-AI`（GitHub 新建环境默认可能仅允许 main，需调整）。`.github/workflows/pages.yml` 只在 `domestic-AI` 推送时自动运行测试、类型检查、静态构建与发布，不会把标准版 main 发布到此 Pages 地址。部署后可执行 `npm run check:pages -- https://ydhhhh.github.io/exam-grading-assistant/` 检查公开入口与本站 PDF 资源。后续 fork 或更改仓库名时，按工作流中的仓库路径重新构建。

这是使用者自备密钥的工具：密钥会存在当前浏览器内存并发送给所选官方供应商，刷新后重新填写；不要在公共电脑或不可信扩展环境中使用共享账户长期密钥。Qwen 可填写由负责人安全生成的[短期 API Key](https://help.aliyun.com/zh/model-studio/generate-temporary-api-key)，到期后重新填写。需要让助教完全接触不到共享密钥时，使用下述服务器版。Pages 不提供共享凭据、访问码会话或全账户预算限额。

2026-10-30 的无密钥跨域预检中，三家接口均允许 `https://ydhhhh.github.io` 的 `Authorization` 和 `Content-Type` 请求头；Kimi 不允许可选请求追踪头，浏览器版本已移除该头，任务编号仍保留在本机账本。供应商可调整跨域策略；预检成功不代表账户权限、真实推理或校园网络已经通过验收。

## 北大 CLab 部署状态与校园入口

CLab 云主机上运行本项目的 Node 服务，就是服务器版；不需要另写一套判卷程序。Clab 支持创建云主机（4 核、4 GiB 内存、40 GiB 系统盘，校园共享网络），安装 Node.js 22.23.4，并以独立的低权限账户运行生产构建。[CLab 官方快速上手](https://github.com/pkucnc/clab_docs/blob/main/docs/getting-started/introduction.md)说明了校园网络及网关连接；[运营方说明](https://lcpu.dev/news/xlab-course-nodes/)介绍了长期云主机与课程 xLab 的区别。

校园备案以及域名申请需查看现行[信息资产备案/固定 IP 申请/域名申请表单](https://wsyy.pku.edu.cn/fe/taskCenter/matterApplication?app_id=359)，学校[网站备案说明](https://its.pku.edu.cn/portal_5.jsp)称备案面向教职工。

## 部署到自己的服务器

准备一台可从目标校园/运营商网络直接访问的 Linux 服务器（中国大陆或合适的香港线路）、域名和 HTTPS。大陆服务器的域名备案按云平台要求办理，参见[阿里云备案要求](https://www.alibabacloud.com/help/en/icp-filing/basic-icp-service/product-overview/icp-filing-requirements-for-a-regular-website)。本轮没有购买服务器或域名，也没有验证某条公网线路。

可选择在目标服务器执行上面的 Node 启动流程，或使用 Docker Engine 与 Docker Compose 2.24+：

```sh
cp .env.production.example .env.production.local
docker compose up -d --build
```

服务仅绑定服务器本机 `127.0.0.1:3000`，在前面配置 Nginx/Caddy 的域名与 HTTPS。将服务器环境变量 `GRADING_PUBLIC_ORIGIN` 设为实际 HTTPS 网址（如 `https://grading.example.cn`）。反向代理应保留原 `Host` 和 `X-Forwarded-Proto`，请求体上限至少 10 MiB、读超时至少 300 秒；禁用 `/api/` 缓存。局域网/公网直接用普通 HTTP 不适合此程序，浏览器文件处理、加密与锁依赖安全上下文。不要把供应商密钥放进前端变量或代理访问日志。

Compose 可以通过 `NODE_IMAGE` 和 `NPM_REGISTRY` 构建参数选用管理员信任的镜像/依赖源；默认使用官方源。在联网构建机生成容器镜像后也可离线转移到服务器。实际部署前应从大陆浏览器检查首页、本地 PDF 资源、三个供应商的模型权限，再用少量合成材料核验端到端调用。

### 负责人统一配置（可选）

复制的 `.env.production.local` 已被 Git 忽略，密钥只写在该服务器文件或平台 Secret 设置。默认 `test` 不提供共享付费密钥。统一模式设置：

| 变量 | 用途 |
| --- | --- |
| `GRADING_MODE` | `managed`；手填模式为 `test` |
| `GRADING_PUBLIC_ORIGIN` | 公网部署的完整 HTTPS 来源（不带路径），用于同源校验及会话；本机可省略 |
| `GRADING_PREPARE_API_KEY` | 整理规则阶段密钥 |
| `GRADING_API_KEY` | 姓名学号识别及初评密钥 |
| `GRADING_REVIEW_API_KEY` | 独立复核密钥，不自动借用其他阶段 |
| `GRADING_ACCESS_CODE` | 至少 16 字符的助教访问口令 |
| `GRADING_SESSION_SECRET` | 至少 32 字符的随机会话签名密钥 |
| `GRADING_STAGE_PROFILES` | 可选，三个阶段的公开配置 JSON；不填即使用上表默认组合 |

公开配置格式为 `{prepare,grade,review}`，每个配置含且仅含 `{provider,model,reasoning,outputTokens,pricing}`。`pricing` 含 `{input,cachedInput,output,budgetFx,version}`，与 `lib/grading/providers.mjs` 的默认示例一致；不放密钥、地址或身份信息。Kimi/Qwen 费率单位是人民币/百万 token（budgetFx=1）；DeepSeek 采用美元高峰费率及 7.5 预算换算系数，不能混用单位。价格只是 2026-10-30 快照，使用前应重新核对，配置覆盖预期用量。缓存优惠只按返回用量计入。

修改配置后重新启动 Node 服务，或执行 `docker compose up -d --force-recreate`。统一模式的页面只能查看配置，不能覆盖服务端密钥或模型。登录会话有效期 8 小时。共享账户的全局额度/限流应在供应商平台设置，浏览器预算不等于整个账户的硬限额。

## 验证范围

此前使用合成材料和模拟接口，检查三阶段参数/密钥分流、国内端点白名单、准备费并入初评账本、独立复核、分歧与异常处理、预算预留、图片隔离、恢复防重发以及密钥不持久化。规则确认修复后，两种部署共用的 318 项离线测试通过（含 Node 22.23.4 全量验证），含浏览器直连、服务端会话、阶段密钥隔离和统一模式备份的付费调用拦截。实际 Chromium 使用模拟响应通过三家服务商 × 四种操作共 12 条路径，全程没有外部模型请求。最终类型检查、Pages 静态导出及 Node 生产构建均已通过；静态产物 240 个文件、约 6.9 MiB。本机子路径页面及 JS/CSS/PDF 资源实际返回成功，浏览器已验证演示批改、分歧保留、PDF 原卷预览及刷新恢复。HTTPS 代理下的登录、会话及密钥隔离已用合成凭据验证；浏览器已检查三阶段切换、演示分歧、原卷预览及刷新恢复。Docker 配置已审查，但本机没有 Docker，未实际构建容器镜像。这些离线验证不代表手写材料准确率、正式评分或大陆公网验收。

2026-10-30 另经授权完成 5 次 DeepSeek 合成材料请求：规则整理 1 次、身份识别 2 次、初评 2 次，费用估算约 0.0573 元。两份初评为预期的 4 分和 0 分；印刷身份样本被手写专用提示词排除，不能视为身份识别通过；独立复核未调用。测试保留 VPN，不代表校园网直连。此次规则确认修复使用保存的合成返回离线回放，已验证普通说明可确认、旧警告逐项处理、无效分值拦截、修改撤销确认及刷新恢复，无新增付费请求。

## 维护与来源

- `lib/grading/providers.mjs`：模型白名单、阶段默认、参数与费用。
- `lib/grading/api-core.mjs`：两种部署共用的官方接口协议、结果校验与评分逻辑。
- `lib/grading/api-service.mjs`、`server-runtime.mjs`：服务器密钥与访问会话。
- `lib/grading/browser-api.mjs`、`browser-deployment.mjs`：Pages 直连接口、个人密钥模式及子路径配置。
- `app/StageConfiguration.tsx`、`app/page.tsx`：三阶段设置与操作页面。
- `lib/grading/browser-workflow.mjs`：批次锁定、队列、费用、备份、恢复与导出。
- `lib/grading/preparation-review.mjs`、`app/PreparationReview.tsx`：规则说明与待处理问题、本地核对修正及依据保存。
- `Dockerfile`、`compose.yaml`、`scripts/*domestic*.mjs`：独立服务器部署与检查。
- `deploy/clab/grading.service`、`deploy/clab/nginx.conf.example`：CLab 服务和 HTTPS 反向代理模板；当前开放状态见上文。
- `.github/workflows/pages.yml`、`scripts/*pages*.mjs`：Pages 静态构建、资源检查、预览与自动发布。

官方依据：[Kimi K3.1 Pro](https://platform.kimi.com/docs/guide/kimi-k3-1-pro-quickstart)、[Kimi 价格](https://platform.kimi.com/)、[DeepSeek Responses](https://api-docs.deepseek.com/guides/responses_api/)、[DeepSeek 价格](https://api-docs.deepseek.com/quick_start/pricing/)、[Qwen Chat 参数](https://help.aliyun.com/en/model-studio/qwen-api-via-openai-chat-completions)、[Qwen 结构化输出](https://help.aliyun.com/en/model-studio/qwen-structured-output)、[Qwen3.8 Max](https://help.aliyun.com/en/model-studio/qwen3-8-max)、[Qwen3.8 Flash](https://help.aliyun.com/en/model-studio/qwen3-8-flash)。这里只登记链接，没有下载外部文献。

保留上游第三方许可；未为用户原创代码额外设定开源许可证。历史 Sites 模板文件不参与本分支的构建或运行，不向原标准版 Sites 项目发布此分支。
