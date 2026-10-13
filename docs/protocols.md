# 协议支持

页面内的链接由 `assets/scripts/protocols.js` 统一处理。模块在页面加载后扫描全部 `<a>` 元素，识别地址方案，据此决定跳转方式、安全属性与提示内容，并对外暴露 `window.Protocols`。

## 分类

| 分类 | 含义 | 处理方式 |
| --- | --- | --- |
| web | 浏览器可直接打开 | 站外链接补 `target="_blank"` 与 `rel="noopener noreferrer"` |
| native | 交给系统关联应用 | 保留原样，登记方案名 |
| app | 需要本机已安装客户端 | 保留原样，提示所需条件 |
| legacy | 现代浏览器多已停用 | 显示方案标签，地址以等宽字体列出，附复制入口 |
| p2p | 需要专用客户端或网关 | 同 legacy |
| crypto | 需要钱包应用 | 同 legacy |
| feed | 订阅协议，通常交给阅读器 | 同 legacy |
| altnet | 需要专用客户端或代理 | 同 legacy |
| unsafe | 存在安全影响 | 移除 `href`，置为不可聚焦与不可点击 |

分类之外还有两条兜底规则。以 `web+` 开头的自定义方案归入 app 分类，提示需要注册处理程序；未登记的其他方案归入 unknown 分类，同样显示标签与复制入口。

相对地址、锚点、查询串与协议相对地址不参与分类，保持原样。

## 登记方案

### web

`http` `https`

### native

`mailto` `tel` `sms` `smsto` `geo` `webcal` `callto` `facetime`

### app

即时通信与协作：`xmpp` `jabber` `irc` `ircs` `matrix` `sip` `sips` `skype` `tg` `whatsapp` `line` `threema` `weixin` `wecom` `dingtalk` `lark` `feishu` `tencent` `mqq` `qq` `discord` `slack` `zoommtg` `msteams`

内容与电商：`alipay` `alipays` `taobao` `tm` `zhihu` `bilibili` `xhs` `douyin` `kuaishou` `sinaweibo`

游戏平台：`steam` `epic`

邮件与目录服务：`smtp` `pop` `pop3` `imap` `ldap` `ldaps`

系统与应用：`market` `intent` `android-app` `itms-apps` `view-source` `blob` `filesystem` `chrome` `resource` `moz-extension` `chrome-extension` `jar`

传输通道：`ws` `wss`

### legacy

文件与目录：`file` `ftp` `ftps` `sftp` `tftp` `nfs` `smb`

检索与目录：`gopher` `gophers` `finger` `wais` `whois` `archie` `veronica` `prospero` `z3950` `cddb`

终端与主机：`telnet` `tn3270` `rlogin` `rsh` `ssh`

新闻与时间：`nntp` `nntps` `news` `daytime` `netstat` `ntp` `dns`

流媒体：`rtsp` `rtsps` `rtmp` `rtmps` `mms` `mmsh`

### p2p

`magnet` `ed2k` `thunder` `torrent` `bittorrent` `ipfs` `ipns` `dat` `hyper` `ssb` `onion` `i2p` `zeronet` `freenet` `sia` `ar`

### crypto

`bitcoin` `bitcoincash` `ethereum` `lightning` `litecoin` `monero` `dogecoin` `nano` `solana`

### feed

`feed` `rss` `atom` `podcast` `itpc` `pcast` `opml`

### altnet

`gemini` `titan` `spartan` `nex` `scorpion` `molerat` `nostr` `acct` `at`

### unsafe

`javascript` `vbscript` `data`

## 设备档位

minimal 档位下不生成标签、地址与复制入口，节点数量与排版开销随之下降；方案识别与安全处理仍然执行。

