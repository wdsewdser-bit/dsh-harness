# execution-permit/1

在已经准备好的 build copy 上追加；不修改 pristine 安装。由 verification/prepare-build.mjs 安装，可重复执行。不需要新依赖。

- dsh-llm 在真实 adapterStream 内、prepareCall 前拒绝未加入协议的 adapter。
- withExecutionCall 显式传播 source-bound C capability；iterator 每次 next/return 都保持调用来源。
- DeepSeek 的 send-started 回调同步取得 X permit，异常不被 phase observer 隔离吞掉，因此真正 fetch 之前可拒绝内部重试。
- Messages/Files/model-list 网络均通过 executionNetwork。Response headers 不表示传输排空，正常 producer 终结才结清正常请求；异常或提前关闭保持不确定。
- 不把 llm/dispatch 观察事件当许可，visibility 的投递 committed 语义不变。

回归：packages/profiles/test/execution-entry.test.mjs。含真正 DeepSeek provider 到 127.0.0.1 临时端口，无真实凭据、无外部计费。准备边界、发送栅栏均有删除变异。

旧 build 不含这个契约时，autonomy:on 不授予完整 transport coverage；不能悄悄回退成采样证明。自定义 adapter 只有在其全部 IO 真正服从协议时才能声明支持。
