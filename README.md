# 日报截图登记

两页 Vue H5：员工在 `/` 首次选择姓名，选择、拖入或粘贴截图后提交；管理员在 `/admin` 输入密码，查看当天 33 人的提交状态，未提交排在前面，点击蓝色姓名查看截图。两页顶部的日期可以切换到过去某天，供补传和回看。每天按北京时间自动切换到新日期，历史图片和记录保留。

## 本地运行

需要 Node.js 24 或更新版本（后端使用 Node 内置 SQLite 模块）。

```bash
npm install
ADMIN_PASSWORD='你的本地管理员密码' npm run dev
```

员工页：`http://127.0.0.1:5173/`；管理员页：`http://127.0.0.1:5173/admin`。首次选中的姓名保存在当前浏览器；没有员工身份认证，上传成功即视为该人该日已提交。

## 部署

当前部署在移动服务器 `ssh mobile`：员工页 `https://br05.xiaoyuqi.top/`，管理员页 `https://br05.xiaoyuqi.top/admin`。Nginx 监听 1004 并转发到本机 19004，应用运行在独立的 Node 24 容器中。发布目录是 `/opt/wbr/daily-report/current`，SQLite 数据库及截图保存在 `/opt/wbr/daily-report/data`，不随版本发布覆盖；Nginx 配置见 [deploy/nginx-1004.conf](deploy/nginx-1004.conf)。首次发布版本为 `/opt/wbr/daily-report/releases/20260923-2235`。若需回退本次首次发布，可停止 `daily-report-archive` 容器，移除本系统的 `/etc/nginx/conf.d/daily-report-1004.conf` 并重载 Nginx；保留 `data` 目录。

自行部署时：

```bash
npm run build
ADMIN_PASSWORD='你的管理员密码' HOST=0.0.0.0 PORT=3000 DATA_DIR=/持久化目录 npm start
```

将你的域名通过 HTTPS 反向代理指向 3000 端口，员工访问域名首页，管理员访问 `/admin`。生产环境必须设置 `ADMIN_PASSWORD`；若 HTTPS 在反向代理终止，同时设置 `PUBLIC_HTTPS=1` 以启用安全 Cookie。`DATA_DIR` 保存 `records.sqlite` 和 `uploads/` 原始截图，需使用持久化磁盘并一起备份；运行中备份数据库应使用 SQLite 在线备份方式，或先停止服务再复制整个目录。若目录中存在旧版 `records.json`，首次启动会将它迁入 SQLite，并保留原 JSON 文件。程序只接收 6 MB 以内的 PNG、JPG、WebP 图片；手机微信优先从相册选择截图，粘贴能力取决于微信浏览器。

## 验证

```bash
npm test
npm run build
```

设计图保存在 [design](design/README.md)。
