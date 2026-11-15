/**
 * 极小的测试骨架。
 *
 * 为什么不用 node:test / node --test：某些受限沙箱里它要 spawn 子进程，
 * 会被 EPERM 挡住。这里就是一个计数器加断言（照 fun-world / feed-world 的做法）。
 *
 * 用法：test('名字', fn) 注册，最后 `await report()` 跑完并决定退出码。
 * 注意 `report()` 必须 `await`——不 await 的话测试还没跑完进程就退出了。
 */
const tests = [];

export function test(name, fn) {
  tests.push({ name, fn });
}

export async function report() {
  let passed = 0;
  const failed = [];
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log(`  ok ${t.name}`);
    } catch (err) {
      failed.push({ name: t.name, err });
      console.log(`  FAIL ${t.name}`);
      console.log(`       ${err?.message ?? err}`);
    }
  }
  console.log(`\n${passed}/${tests.length} 通过`);
  if (failed.length) process.exitCode = 1;
  return failed.length;
}
