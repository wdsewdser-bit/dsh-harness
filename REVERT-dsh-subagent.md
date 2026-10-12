# 如何撤销对 dsh-subagent 的改动

> 2026-09-15：0.1.6 升级覆盖了 app 副本；本次已重新应用到两份副本，两处都删除下面的守卫即可回滚。

文件：

- `D:\dsh-test\app\node_modules\@deepseek-ai\dsh-subagent\lib\index.js`
- `D:\dsh-test\home\profiles\node_modules\@deepseek-ai\dsh-subagent\lib\index.js`

改的是 `notifySettlement()` 里 `this.sendWaking(...)` 之前的这段守卫。
**删除下面这个 if 块（连同注释）**即可完全恢复原状：

```js
            // Agent Team owns its own upward reporting: room handoff and send_message
            // deliver one deliberate hop at a time, and team-idle-watch wakes the Lead
            // once the whole Team stops. Letting every continuable child settlement also
            // start a parent turn turned one real test into 26 extra root turns, so Team
            // members receive the notice at their next step instead of a new turn.
            const teams = typeof this.ctx.get === "function" ? this.ctx.get("agentTeams") : void 0;
            if (teams !== void 0 && typeof teams.tryMembership === "function") {
                try {
                    if (teams.tryMembership(parent) !== void 0) {
                        parent.inject(message);
                        return;
                    }
                } catch {
                    /* Not a Team member: fall through to the waking path. */
                }
            }
```

原文件里它在 `this.sendWaking(parent, message, ...)` 之前。
**只影响测试实例（`D:\dsh-test`），生产（`D:\dsh\app`）未动。**

每次 `D:\dsh-test\app` 升级 DSH 后，都要检查这份补丁是否还在；
它对应的设计记录在 `D:\dsh\docs\agent-team-v2-design.md` 第 56、65 节。
