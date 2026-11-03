// 语音输入的契约检查（对齐客户端）。
//
// 这一条最容易「看起来有、其实不通」：按钮画出来、点了录音，但
//   · 结束时不释放麦克风（标签页一直亮录音）；
//   · 自己另开一个上传接口，绕开既有的 12 MiB / 429 文案；
//   · Safari 没有 audio/mp4 回退，点了直接抛错。
// 所以查四件事，而不是查“有没有 MediaRecorder”。
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../app/components/TaskChatPanel.tsx', import.meta.url), 'utf8');

assert.ok(/getUserMedia/.test(src), '必须申请麦克风权限');
assert.ok(/new MediaRecorder/.test(src), '必须真的录音，而不是只画按钮');
assert.ok(/isTypeSupported/.test(src), '必须按浏览器支持挑编码（Safari 只有 audio\/mp4）');
assert.ok(/getTracks\(\)\.forEach\([^)]*stop/.test(src), '录音结束必须释放麦克风轨道');
assert.ok(/data-testid="chat-voice-toggle"/.test(src), '按钮要有 testid，否则断言只能靠文案');
assert.ok(/addFiles\(\[file\]\)/.test(src), '录音产物必须走既有附件链路（addFiles），不要另起上传');

// 反向：不允许语音自己再调一次上传接口（会出现两套错误文案与限额）。
// 只数「真正发起请求」的那一处；注释里提到路径不算。
const uploadCalls = src.match(/fetch\('\/api\/hub\/upload'/g) || [];
assert.equal(uploadCalls.length, 1, `上传请求应只有一处（附件链路），实际 ${uploadCalls.length} 处`);

// 权限被拒与没有麦克风要给出不同文案，不能一句“失败”糊过去。
assert.ok(/NotAllowedError/.test(src), '权限被拒要单独识别');
assert.ok(/录音太短/.test(src), '误点一下要明确拒绝，而不是上传 0.1 秒噪音');

console.log('chat voice contract ok');
