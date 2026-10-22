import test from 'node:test';
import assert from 'node:assert/strict';
import { responseStream } from './native.ts';

const frame = value => `data: ${JSON.stringify(value)}\n\n`;
test('fragmented SSE retains text, reasoning and function argument order', () => {
  const changes = [], stream = responseStream(value => changes.push(value));
  const wire = frame({choices:[{delta:{reasoning_content:'思考',content:'你',tool_calls:[{index:0,id:'call1',type:'function',function:{name:'read_note',arguments:'{"id":'}}]}}]})
    + frame({choices:[{delta:{content:'好',tool_calls:[{index:0,function:{arguments:'"123"}'}}]},finish_reason:'tool_calls'}]}) + 'data: [DONE]\n\n';
  for (let index = 0; index < wire.length; index += 7) stream.push(wire.slice(index,index+7));
  const result = stream.finish();
  assert.equal(result.content,'你好'); assert.equal(result.reasoningContent,'思考');
  assert.equal(result.toolCalls[0].function.arguments,'{"id":"123"}');
  assert.deepEqual(changes.filter(value => value.type==='delta').map(value => value.text),['你','好']);
});
test('incomplete transport and malformed payloads cannot complete a reply', () => {
  const unfinished = responseStream(() => {}); unfinished.push(frame({choices:[{delta:{content:'partial'}}]}));
  assert.throws(() => unfinished.finish(),/提前中断/);
  const malformed = responseStream(() => {}); assert.throws(() => malformed.push('data: nope\n\n'),/无效/);
  const overflow = responseStream(() => {}); assert.throws(() => overflow.push('x'.repeat(2*1024*1024+1)),/过长/);
});
test('a consumer error propagates so the bridge can cancel its transport', () => {
  const stream = responseStream(() => {throw new Error('cancel consumer');});
  assert.throws(() => stream.push(frame({choices:[{delta:{content:'a'}}]})),/cancel consumer/);
});
