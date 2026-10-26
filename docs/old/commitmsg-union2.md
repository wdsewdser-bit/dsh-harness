docs: 并集复核须对实际父取；门禁判词不得 grep 诊断词

- 并集复核：清关给出的并集读数只对当时的 main 有效。我在清关与并入之间提交了 77bfb8a，
  使一次快进变成真合并 7a0315da（tree 3accb2e8 != 清关的 18edf143）。
  落成动作序列：先并入后提交自己的文档，或并入时对实际父重取 merge-tree。
  自认：本会话同族第三次，且我在持有该条款时又踩了一次。

- 门禁判词：citation_integrity 的绿含 57 行 FAIL 诊断而测试 4 passed；
  FAIL 一词同名不同义（逐 token 未唯一解析 vs 门禁未登记）。
  判词只取 M11-CITE-*-EXC/SUMMARY 与 test result，不 grep FAIL。
  且绿 = 未登记为 0，不等于「引用可唯一解析」（68 token，含已登记歧义）。
