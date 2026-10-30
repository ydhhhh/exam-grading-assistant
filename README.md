# 阅卷助手 · 国内三阶段版

本目录维护 GitHub 的 `domestic-AI` 分支（Git 分支名不能含空格）。它从标准版 main 的 `e798040` 功能源版本分出，保留 PDF 答卷、逐题建议评分、独立模型复核、人工改分、费用账本、断点恢复及 CSV 导出。**不支持 GPT/OpenAI API**。

当前交付为可独立部署的 Next.js 网站，尚未部署到国内公网。标准版的原网址已于 2026-10-30 更新到 v5，但那个网址不是国内版入口。国内版不依赖 ChatGPT 登录或 Sites/Cloudflare 运行服务，浏览器字体、PDF.js 及转图资源均由本站提供。大陆实际可达性还须在选定服务器、域名后实测，不能由源码或 GitHub 分支保证。

## 三阶段设置

| 步骤 | 默认服务商 | 默认模型 |
| --- | --- | --- |
| 整理评分规则 | Kimi | `kimi-k3.1-pro` |
| 姓名学号识别和逐题初评 | DeepSeek | `deepseek-flash` |
| 独立模型复核 | Kimi | `kimi-k3.1-pro` |

每个步骤都可选择 Kimi、DeepSeek、Qwen，并单独填写密钥；同一供应商可在不同步骤使用同一把或不同账户的密钥。Qwen 提供 `qwen3.8-max` 与 `qwen3.8-flash`。只列已核实的视觉模型及官方国内接口，不接受自定义转发地址。首次请求后锁定本批次三个步骤的模型、参数和费率，继续处理不会悄悄换模型。初评和复核必须使用不同模型。

Kimi K3.1 Pro、DeepSeek Flash 的图片能力及当前模型名称均已按官方资料核对；接口适配使用模拟请求验证，尚未进行本轮真实 API/手写卷评分验收。Kimi K3.1 Pro 的账户开通要求以官方平台为准。

## 助教使用

1. 打开部署后的网址，先体验合成演示，不产生 API 费用。
2. 选择试题、参考答案、评分细则（PDF、PNG/JPEG/WebP、UTF-8 文本；Word 请先另存 PDF）。每份原件最多 3 MiB，三份合计最多 6 MiB。PDF 在浏览器转图，转图后超限须减小材料。
3. 在三个 API 卡片分别选择服务商、模型、密钥。默认手填模式只把密钥保留在当前页面内存；刷新后重新填写，进度和导出不含密钥。负责人统一配置模式则先用访问码登录。
4. 整理评分规则并人工核对题号、分值、评分点。负责人可导出一份统一规则，其他助教导入，避免重复整理和规则漂移。
5. 每名学生一份 `学号.pdf`，若有 m 道题则严格 m+1 页：第 1 页姓名学号，第 2 至 m+1 页对应各题。选择答卷文件夹，先检查页数，再开始批改。首页身份图片与匿名作答分别发送。
6. 独立复核默认开启，只查看原作答及教师规则，不接收初评分数、理由或标记。逐点不一致、缺页、费用未定等保持可见；有争议的建议分留空，人工对照原卷确认后再汇总。
7. 保持网页打开，可暂停、下载进度备份、按学号查看改分或导出建议成绩。关闭页面不会继续后台执行；费用未定的调用不自动重发。

国内版使用独立的浏览器存储及流水线版本，不加载标准版旧进度。升级前请保留旧站及备份，使用统一规则新建国内批次。学生材料、密钥、成绩、进度备份不进入 Git。正式成绩仍须教师或授权助教实质审阅确认，程序不连接教务系统。

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

本轮使用合成材料和模拟接口，检查三阶段参数/密钥分流、国内端点白名单、准备费并入初评账本、独立复核、分歧与异常处理、预算预留、图片隔离、恢复防重发以及密钥不持久化。275 项离线测试、独立安装、类型检查、生产构建和本机页面/API/PDF资源检查已通过。HTTPS 代理下的登录、会话及密钥隔离已用合成凭据验证；浏览器已检查三阶段切换、演示分歧、原卷预览及刷新恢复。Docker 配置已审查，但本机没有 Docker，未实际构建容器镜像。没有真实模型、手写材料、准确率、正式评分或大陆公网验收。

## 维护与来源

- `lib/grading/providers.mjs`：模型白名单、阶段默认、参数与费用。
- `lib/grading/api-service.mjs`、`server-runtime.mjs`：国内官方接口适配、密钥与访问会话。
- `app/StageConfiguration.tsx`、`app/page.tsx`：三阶段设置与操作页面。
- `lib/grading/browser-workflow.mjs`：批次锁定、队列、费用、备份、恢复与导出。
- `Dockerfile`、`compose.yaml`、`scripts/*domestic*.mjs`：独立部署与检查。

官方依据：[Kimi K3.1 Pro](https://platform.kimi.com/docs/guide/kimi-k3-1-pro-quickstart)、[Kimi 价格](https://platform.kimi.com/)、[DeepSeek Responses](https://api-docs.deepseek.com/guides/responses_api/)、[DeepSeek 价格](https://api-docs.deepseek.com/quick_start/pricing/)、[Qwen Chat 参数](https://help.aliyun.com/en/model-studio/qwen-api-via-openai-chat-completions)、[Qwen 结构化输出](https://help.aliyun.com/en/model-studio/qwen-structured-output)、[Qwen3.8 Max](https://help.aliyun.com/en/model-studio/qwen3-8-max)、[Qwen3.8 Flash](https://help.aliyun.com/en/model-studio/qwen3-8-flash)。这里只登记链接，没有下载外部文献。

保留上游第三方许可；未为用户原创代码额外设定开源许可证。历史 Sites 模板文件不参与本分支的构建或运行，不向原标准版 Sites 项目发布此分支。
