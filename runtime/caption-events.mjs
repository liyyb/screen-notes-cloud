/** Replaceable live text and bounded final history. No database reads in snapshots. */
export class CaptionEvents {
  constructor(sessionId, epoch = 1, now = () => performance.now()) {
    this.sessionId = sessionId; this.epoch = epoch; this.now = now;
    this.seq = 0; this.current = null; this.finals = []; this.versions = new Map();
    this.receivedAt = null;
  }
  accept(event) {
    if (event.session_id !== this.sessionId || event.engine_epoch !== this.epoch) return false;
    const prior = this.versions.get(event.utterance_id);
    if (prior?.final || (prior && event.revision <= prior.revision)) return false;
    const final = event.type === 'final';
    this.versions.set(event.utterance_id, {revision:event.revision,final});
    // Bounded recent identity cache; persisted finals are additionally idempotent in SQLite.
    if(this.versions.size > 512) this.versions.delete(this.versions.keys().next().value);
    const item = {...event,text:String(event.text ?? '').trim()};
    if (final) {
      if(item.text) this.finals = [...this.finals,item].sort((a,b)=>a.start_ms-b.start_ms).slice(-3);
      if(this.current?.utterance_id===event.utterance_id) this.current=null;
    } else this.current=item;
    this.seq++;
    this.receivedAt = Date.now();
    if (item.text) {
      this.firstTextAt ??= this.receivedAt;
      if (final) this.firstFinalAt ??= this.receivedAt;
    }
    return true;
  }
  snapshot() {
    const current=this.current?.text ? this.current : null;
    return {session_id:this.sessionId,engine_epoch:this.epoch,event_seq:this.seq,current,
      recent:this.finals,display_text:current?.text || this.finals.at(-1)?.text || '',received_at:this.receivedAt};
  }
}
