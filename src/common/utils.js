// 通用工具函数（可按需扩展）
function deepClone(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch (e) {
    console.error('Deep clone failed:', e);
    return obj;
  }
}
exports.deepClone = deepClone;