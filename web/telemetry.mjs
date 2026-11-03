export const TELEMETRY_VERSION = 2;
export const IDLE_AFTER_MS = 30000;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const milliseconds = ['durationMs','foregroundMs','activeMs','idleMs','hiddenMs','blurredMs'];
const counters = ['clicks','pointerSamples','pointerDistancePx','scrolls','choiceChanges','inputActions','pasteCount','selectionCount','focusSwitches','hoverMs'];
const stageKey = event => JSON.stringify([event.runId || null,event.phase || '',event.taskId || null,event.updateId || null]);
function stageFor(event) {
  return { runId:event.runId || null,phase:event.phase || '',taskId:event.taskId || null,updateId:event.updateId || null,...Object.fromEntries(milliseconds.map(key=>[key,null])),clicks:0,choiceChanges:0,inputActions:0,pasteCount:0,scrolls:0 };
}
/** Descriptive observations only. Foreground/recent interaction is not attention or comprehension. */
export function summarizeBehavior(events = []) {
  const unique = new Map();
  for (const [index,event] of events.entries()) if(event && typeof event === 'object') unique.set(event.id || `missing-${index}`,event);
  const rows = [...unique.values()], stages = new Map(), sources = new Map();
  const totals={events:rows.length,pageCount:new Set(rows.map(e=>e.pageId).filter(Boolean)).size,...Object.fromEntries(milliseconds.map(key=>[key,null])),...Object.fromEntries(counters.map(key=>[key,0]))};
  const quality={telemetryVersions:[],uiVersions:[],legacyEvents:0,storageFailures:0,exportWarnings:0,hasSegments:false,warnings:[]};
  const runIds=new Set(rows.map(e=>e.runId).filter(Boolean));
  const versions=new Set(), uiVersions=new Set();
  for(const event of rows) {
    const data=event.data || {}, key=stageKey(event);
    if(!stages.has(key))stages.set(key,stageFor(event));
    const stage=stages.get(key);
    if(data.telemetryVersion)versions.add(data.telemetryVersion);else quality.legacyEvents++;
    if(data.uiVersion)uiVersions.add(data.uiVersion);
    if(event.type==='engagement_segment') {
      quality.hasSegments=true;
      for(const metric of milliseconds){const value=finite(data[metric]);stage[metric]=(stage[metric]??0)+value;totals[metric]=(totals[metric]??0)+value;}
    }
    const count=(metric,amount=1)=>{totals[metric]+=amount;if(metric in stage)stage[metric]+=amount;};
    if(event.type==='click')count('clicks');
    if(event.type==='pointer_move'){count('pointerSamples');count('pointerDistancePx',finite(data.distancePx));}
    if(event.type==='scroll')count('scrolls');
    if(event.type==='control_change' && data.revised===true)count('choiceChanges');
    if(event.type==='field_session')count('inputActions',finite(data.inputActions));
    // Legacy recordings lack field_session aggregates; their input_action rows were one per input.
    if(event.type==='input_action' && !data.telemetryVersion)count('inputActions');
    if(event.type==='paste')count('pasteCount');
    if(event.type==='selection')count('selectionCount');
    if(event.type==='focus_in')count('focusSwitches');
    if(event.type==='hover_end')count('hoverMs',finite(data.durationMs));
    if(event.type==='storage_failure')quality.storageFailures++;
    if(event.type==='export_warning')quality.exportWarnings++;
    if(data.sourceId && ['source_exposure_end','source_viewport','hover_end'].includes(event.type)) {
      const sourceKey=JSON.stringify([event.runId||null,data.sourceId]);
      if(!sources.has(sourceKey))sources.set(sourceKey,{runId:event.runId||null,sourceId:data.sourceId,exposureMs:0,exposureCount:0,maxRatio:0,hoverMs:0});
      const source=sources.get(sourceKey);
      source.maxRatio=Math.max(source.maxRatio,Math.min(1,finite(data.ratio)));
      if(event.type==='source_exposure_end'){source.exposureMs+=finite(data.durationMs);source.exposureCount++;}
      if(event.type==='hover_end')source.hoverMs+=finite(data.durationMs);
    }
  }
  quality.telemetryVersions=[...versions].sort();quality.uiVersions=[...uiVersions].sort();
  if(!rows.length)quality.warnings.push('행동 로그가 없습니다.');
  else if(!quality.hasSegments)quality.warnings.push('이전 기록에는 전경·유휴 시간 구간이 없어 해당 시간을 계산하지 않습니다.');
  if(quality.legacyEvents)quality.warnings.push('이전 형식의 로그가 포함되어 일부 행동 지표가 비어 있거나 서로 다를 수 있습니다.');
  if(quality.storageFailures)quality.warnings.push('기기 저장 실패 기록이 있습니다. 원본과 복구 파일을 함께 확인하세요.');
  if(quality.exportWarnings)quality.warnings.push('내보내기 경고가 있습니다. 로그의 완전성을 확인하세요.');
  if(uiVersions.size>1)quality.warnings.push('서로 다른 UI 버전의 행동이 섞여 있습니다.');
  if(runIds.size>1)quality.warnings.push('여러 실행의 로그를 합산했습니다. 단계·자료별 행은 실행별로 구분됩니다.');
  return {totals,stages:[...stages.values()],sources:[...sources.values()],quality};
}
