# hass

Home Assistant 实体与状态的 MSP World 节点。此仓库作为 [msp-world-cli](https://github.com/msp-world/msp-world-cli) 的子模块使用，依赖同级 `shared` 和主仓库中的 `msp-ts`，不能仅克隆本仓库后直接运行。

## 使用

需要 Node.js 22.6 或更新版本。

```bash
git clone --recurse-submodules https://github.com/msp-world/msp-world-cli.git
cd msp-world-cli
npm start -- hass
```

主要配置：HASS_URL、HASS_TOKEN、HASS_ALLOWED_DOMAINS、HASS_WATCH_ENTITIES。通用连接配置及详细说明见[主仓库](https://github.com/msp-world/msp-world-cli)。

## 上游与致谢

本模块属于 Cortico 社区生态的 MSP 适配；具体上游项目和作者尚未核实。

本仓库是 MSP 适配实现，并非上游原仓库。感谢上游作者及贡献者。
