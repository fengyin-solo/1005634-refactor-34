// 测试用：给 Node 环境补一个内存版 localStorage，让 data/local-store 正常读写。
const memory = new Map()
globalThis.window = {
  localStorage: {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => {
      memory.set(key, String(value))
    },
    removeItem: (key) => {
      memory.delete(key)
    },
  },
}
