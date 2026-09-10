# npm 包发布

两个包独立发版，向 GitHub 推送对应 tag 后，`publish-npm.yml` 自动校验、测试、构建并发布所选包。

| Tag | 版本声明 | 发布包 |
| --- | --- | --- |
| `sdk-v<version>` | 根目录 `package.json` | `alibabacloud-agentcore-sdk` |
| `collaboration-v<version>` | `packages/collaboration/package.json` | `alibabacloud-agentcore-collaboration` |

当前工作流只接受 `X.Y.Z` 正式版本，并发布到 npm 的 `latest`。tag 必须与对应 `package.json` 的版本一致；一个 tag 只发布一个包。

## 一次性配置

采用 [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)，无需配置 `NPM_TOKEN` 或 `NODE_AUTH_TOKEN`。工作流使用 GitHub-hosted runner、Node.js 24 和 npm 11，只有发布任务拥有 `id-token: write` 权限。

1. 将工作流提交并推送到 GitHub。
2. 在 GitHub 仓库 **Settings → Environments** 创建 `npm` Environment。可按需设置审批人和允许的发布 tag。
3. 分别在下面两个 npm 包的 **Settings → Trusted publishing** 中添加 GitHub Actions：
   - [基础包](https://www.npmjs.com/package/alibabacloud-agentcore-sdk)
   - [协作包](https://www.npmjs.com/package/alibabacloud-agentcore-collaboration)

| 字段 | 值 |
| --- | --- |
| Organization or user | `ai-agentcore` |
| Repository | `agentcore-sdk-nodejs` |
| Workflow filename | `publish-npm.yml` |
| Environment name | `npm` |
| Allowed actions | 允许直接发布 `npm publish` |

两个包都要分别授权。仅允许 `npm stage publish` 不足以运行本工作流；如果 Environment 配置了审批，发布会等待批准。

两个 `package.json` 中的 `repository.url` 必须对应本 GitHub 仓库。公开仓库使用 OIDC 发布时，npm 会自动生成 provenance；私有仓库不支持 provenance，不必为了发布包修改仓库可见性。

## 发布步骤

以基础包的下一补丁版本为例，在仓库根目录执行：

```bash
npm version 0.1.1 --no-git-tag-version
```

若发布协作包，则在 `packages/collaboration` 中执行同一命令。提交对应的 `package.json` 和 `package-lock.json`；基础包版本变更后，在协作目录运行 `npm install --package-lock-only --ignore-scripts`，同步锁文件中的本地基础包记录。需要调整协作包 peer dependency 范围时一并修改。

将改动推送到 GitHub 主分支，确认 CI 通过，再在该提交上创建并推送 tag：

```bash
git tag -a sdk-v0.1.1 -m "Release SDK 0.1.1"
git push https://github.com/ai-agentcore/agentcore-sdk-nodejs.git refs/tags/sdk-v0.1.1
```

协作包使用 `collaboration-v0.1.1`。如果协作包依赖尚未发布的基础包版本，先等基础包发布完成，再推协作包 tag。

工作流在无发布权限的任务中测试和构建，随后上传 `.tgz`；发布任务只下载并上传这个产物，不重新构建或执行包生命周期脚本。

## 验证与失败处理

在 GitHub Actions 确认发布成功，再核查注册表：

```bash
npm view alibabacloud-agentcore-sdk@0.1.1 version dist.integrity --registry=https://registry.npmjs.org
npm view alibabacloud-agentcore-collaboration@0.1.1 version dist.integrity --registry=https://registry.npmjs.org
```

只查询本次发布的包，并在干净目录验证安装。已发布的 `0.1.0` 不会自动重发；不要覆盖或移动已有发布 tag。上传失败后先检查该版本是否已存在，再决定重跑；已存在的版本不能用新内容覆盖，应使用新版本。

认证失败时优先检查两个包各自的 Trusted Publisher 配置是否完整、Environment 和工作流文件名是否匹配，以及是否允许 `npm publish`。
