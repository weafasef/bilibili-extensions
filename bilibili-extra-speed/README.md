# B站倍速增强（Edge 扩展）

在哔哩哔哩播放器原生的倍速菜单中增加 **2.5x、3x、4x、4.5x、5x** 五个档位。菜单样式、位置、全屏行为都沿用 B 站原生播放器，不会额外悬浮一个面板。

> 4x 是顺手补的中间档；如果只想要原计划的 2.5x / 3x / 4.5x / 5x，把 `EXTRA_RATES` 里的 `4` 删掉即可。

## 安装到 Edge

1. 下载或复制本目录 `bilibili-extra-speed/` 到本地。
2. 打开 Edge，地址栏输入 `edge://extensions/`。
3. 打开左下角的「开发人员模式」。
4. 点击「加载解压缩的扩展」，选择 `bilibili-extra-speed` 文件夹。
5. 打开任意 B 站视频，鼠标移到播放器右下角的「倍速」上，菜单里就会多出五个档位。

> 修改代码后，需要在 `edge://extensions/` 里点一下扩展卡片上的「重新加载」，再刷新 B 站页面。

## 与 Global Speed 共存（重要）

Global Speed 默认会把自己的速度持续应用到所有标签页。如果它仍在 B 站生效，会每隔约 1 秒把 B 站菜单选中的速度覆盖掉。想用 B 站菜单控制，请任选一种：

1. 在 Global Speed 的 **URL Rules** 里新建一条规则：URL 条件填 `https://www.bilibili.com/*`，模式选 **Off**。
2. 或者直接在当前 B 站页面暂停 / 关闭 Global Speed。

设置完刷新 B 站页面即可。Global Speed 仍然可以在其他网站正常使用。

## 关于高倍速的声音

- 旧版 Chrome 64 之前确实会在倍速低于 0.5x 或高于 4x 时静音。
- **Chrome 64 起已经取消了这个限制**，改用 WSOLA 处理音频；Edge 基于 Chromium，所以 4.5x/5x 仍然有声音。
- 不过倍速很高时，音频可能出现变调、卡顿或轻微延迟，具体取决于视频音轨和电脑性能。
- 浏览器默认会保持音高（`preservesPitch`），不会简单地把声音变尖。

## 说明

- 扩展只申请了 `https://www.bilibili.com/*` 的运行权限，不联网、不收集数据。
- B 站播放器自己会监听 `video.playbackRate` 的变化，所以选中 4.5x/5x 后，菜单上的文字和高亮会正常同步。
- B 站未登录时可能把倍速菜单替换成「登录可享」，这种情况下需要先登录才能看到菜单。
- 扩展只负责增加档位，不改变 B 站自身的倍速记忆策略；刷新后是否恢复到 5x 取决于播放器。

## 自定义档位

打开 `content.js`，修改第一处常量即可：

```js
const EXTRA_RATES = [2.5, 3, 4, 4.5, 5];
```

支持 0.25–16 之间的小数；改完重新加载扩展并刷新页面。若某个档位 B 站原生已经存在，扩展会自动跳过，不会重复添加。

## 目录

```
bilibili-extra-speed/
├── manifest.json   # Edge Manifest V3 配置
├── content.js      # 注入倍速菜单的逻辑
├── icons/          # 16/32/48/128 图标
└── README.md
```

## 打包上架（可选）

将 `bilibili-extra-speed` 文件夹内的文件压缩成 zip，确保 `manifest.json` 位于 zip 根目录，然后到 Microsoft Partner Center 提交即可。
