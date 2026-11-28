# 社区老幼共托的照护承诺与交接

这个项目用于社区老幼共托的照护承诺与交接的服务端业务。业务服务已提供：家属申请与查询、站点受理确认、排班变更、到站登记、替班与缺口暴露、接送确认与授权变更；联调接收端（家属通知替身）与合成资料核查保持可用。

运行环境为 Node.js 22.23.4，没有第三方运行依赖。`data/catalog.json` 保存领域资料，`data/records.json` 保存按输入顺序排列的合成记录；这些记录可能包含矛盾或尚待核实的状态。字段说明见 [资料约定](docs/资料约定.md)。

本地准备与核查：
```sh
npm ci --ignore-scripts
npm run check:data
npm test
```
资料核查仅确认格式和必要引用。业务测试覆盖配比变化（排班、请假、资质暂停、临时移动）与接送授权变化（服务中更换授权人、旧页面放人、交接后撤销）等可重复检查；联调端测试验证流水语义。

启动业务服务：
```sh
npm start
```
默认监听本机 4400 端口，状态保存在 `.local/care-state.json`，重启后保留在场人员与照护责任。可用 `CARE_PORT`、`CARE_HOST`、`CARE_STATE`、`CARE_CATALOG`、`CARE_RECORDS`、`CARE_SEED`、`CARE_PEER_URL` 覆盖。首次启动会把 `records.json` 中的合成排班纳入初始状态（`CARE_SEED=off` 关闭）。接口与业务规则见 [业务接口](docs/业务接口.md)。

启动联调接收端：
```sh
npm run peer
```
默认监听本机 4300 端口，状态保存在 `.local/peer-state.json`。可用 `PEER_PORT`、`PEER_HOST`、`PEER_STATE` 覆盖。地址、授权头及控制接口见 [联调协议](docs/联调协议.md)。该进程是外部协作方的本地替身，不是业务服务。

容器运行：
```sh
docker build -t shared-care-local .
docker run --rm -p 127.0.0.1:4300:4300 --mount type=volume,source=shared-care-state,target=/home/node/state -e PEER_STATE=/home/node/state/requests.json shared-care-local
```
命名卷保存联调端流水，停止和重启容器不清除它。另开终端可用 `docker run --rm shared-care-local npm run check:data` 核查资料，用 `docker run --rm shared-care-local npm test` 检查联调端，临时目录会由测试自行清理。所有人物、证件、账户和业务编号均为合成值；不需要真实系统账号。
