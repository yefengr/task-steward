# 第三方许可

视觉与语言基础来自 Pi Reach 提交 `0230224`，按 Pi Steward 的界面范围删减适配。

- `pwa/src/app/pwa-theme.css` → `src/pwa-theme.css`（保留任务控制台 token；安全区变量与 44px 触控目标改由下方 npm 包提供）
- `pwa/src/lib/ui/pi-reach-theme.ts` → `src/lib/ui/steward-theme.ts`
- `pwa/src/lib/ui/motion-duration.ts` → `src/lib/ui/motion-duration.ts`
- `pwa/src/lib/ui/viewport-queries.ts` → `src/lib/ui/viewport-queries.ts`
- `pwa/src/lib/i18n/{index.ts,locale.ts,messages/zh.ts,messages/en.ts}` → `src/lib/i18n/`（保留组织方式，界面文案重新编写）

安全区与浮动组件定位能力来自 npm 公开包 `@yefengr/pwa-foundation@0.0.1`（MIT），安装后使用其 `foundation.css` 与 `useFloatingSafeMiddlewares`。

```text
MIT License

Copyright (c) 2026 Jacob Moura
Copyright (c) 2026 yefeng

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
