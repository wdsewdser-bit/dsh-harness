import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { id, hash, fail, operationIdPattern } from '../contracts/index.mjs';
import { CONTEXT_SCHEMA } from './artifact-schema.mjs';

/** Own durable content, ACL, retention and revision metadata; 08 §2.2, §3.3. */
export class ArtifactStore {
  constructor(root) {
    this.root = root;
    fs.mkdirSync(root + '/artifacts', { recursive: true });
    this.db = new DatabaseSync(root + '/context.sqlite');
    this.db.exec(CONTEXT_SCHEMA);
  }

  publish(callId, text, principal, point = () => {}) {
    const data = Buffer.from(text);
    const digest = hash(data);
    const ref = id('artifact');
    const stagingPath = this.root + '/artifacts/' + id('stage').replaceAll(':', '-');
    const contentPath = this.root + '/artifacts/' + digest;
    let descriptor;
    try {
      // Publish and GC share a synchronous writer transaction; no await holds the lock.
      this.db.exec('BEGIN IMMEDIATE');
      descriptor = fs.openSync(stagingPath, 'wx');
      const halfway = Math.floor(data.length / 2);
      fs.writeSync(descriptor, data.subarray(0, halfway));
      point('half');
      fs.writeSync(descriptor, data.subarray(halfway));
      fs.fsyncSync(descriptor);
      point('fsync');
      fs.closeSync(descriptor);
      descriptor = undefined;
      if (!fs.existsSync(contentPath)) {
        fs.renameSync(stagingPath, contentPath);
      } else {
        fs.unlinkSync(stagingPath);
      }
      point('rename');
      if (hash(fs.readFileSync(contentPath)) !== digest) {
        fail('corrupt');
      }
      this.db.prepare(
        'INSERT INTO manifests(ref,sha,bytes,callId) VALUES(?,?,?,?)',
      ).run(ref, digest, data.length, callId);
      this.db.prepare('INSERT INTO grants VALUES(?,?,?)')
        .run(ref, principal.session, principal.agent);
      this.db.prepare('INSERT INTO acl VALUES(?,?,?)')
        .run(ref, principal.session, principal.agent);
      point('before-commit');
      this.db.exec('COMMIT');
      point('after-commit');
      return { artifactRef: ref, sha256: digest, bytes: data.length, callId, mediaType: 'text/plain' };
    } catch (error) {
      if (this.db.isTransaction) {
        this.db.exec('ROLLBACK');
      }
      throw error;
    } finally {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
      }
    }
  }

  read(ref, range, principal) {
    const manifest = this.db.prepare('SELECT * FROM manifests WHERE ref=?').get(ref);
    if (!manifest || !this.db.prepare(
      'SELECT 1 FROM grants WHERE ref=? AND session=? AND agent=?',
    ).get(ref, principal.session, principal.agent)) {
      fail('denied');
    }
    if (
      manifest.state !== 'published' ||
      (manifest.retainUntil !== null && manifest.retainUntil <= Date.now() &&
        !manifest.pinned && !this.db.prepare('SELECT 1 FROM pins WHERE ref=?').get(ref))
    ) {
      fail('expired');
    }
    let content;
    try {
      content = fs.readFileSync(this.root + '/artifacts/' + manifest.sha);
    } catch {
      fail('corrupt');
    }
    if (hash(content) !== manifest.sha) {
      fail('corrupt');
    }
    const offset = range?.offset ?? 0;
    const length = Math.min(range?.length ?? 4096, 4096);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
      fail('INVALID_RANGE');
    }
    return {
      text: content.subarray(offset, offset + length).toString(),
      dataBase64: content.subarray(offset, offset + length).toString('base64'),
      offset,
      length: Math.min(length, Math.max(0, content.length - offset)),
      sha256: manifest.sha,
      bytes: content.length,
    };
  }

  grant(ref, owner, target) {
    if (!this.db.prepare(
      'SELECT 1 FROM acl WHERE ref=? AND ownerSession=? AND ownerAgent=?',
    ).get(ref, owner.session, owner.agent)) {
      fail('denied');
    }
    this.db.prepare('INSERT OR IGNORE INTO grants VALUES(?,?,?)')
      .run(ref, target.session, target.agent);
  }

  revoke(ref, owner, target) {
    if (!this.db.prepare(
      'SELECT 1 FROM acl WHERE ref=? AND ownerSession=? AND ownerAgent=?',
    ).get(ref, owner.session, owner.agent)) {
      fail('denied');
    }
    this.db.prepare('DELETE FROM grants WHERE ref=? AND session=? AND agent=?')
      .run(ref, target.session, target.agent);
  }

  protect(ref, kind, sourceId) {
    if (!['session', 'task', 'verification', 'unknown'].includes(kind)) {
      fail('INVALID_PIN');
    }
    this.db.prepare('INSERT OR IGNORE INTO pins VALUES(?,?,?)').run(ref, kind, sourceId);
  }

  release(ref, kind, sourceId) {
    this.db.prepare('DELETE FROM pins WHERE ref=? AND kind=? AND sourceId=?')
      .run(ref, kind, sourceId);
  }

  extend(ref, until) {
    if (!Number.isSafeInteger(until) || until < Date.now()) {
      fail('INVALID_RETENTION');
    }
    this.db.prepare('UPDATE manifests SET retainUntil=MAX(COALESCE(retainUntil,0),?) WHERE ref=?')
      .run(until, ref);
  }

  terminal(ref, at = Date.now(), pins = false) {
    this.db.prepare('UPDATE manifests SET terminalAt=?,retainUntil=?,pinned=? WHERE ref=?')
      .run(at, at + 30 * 86400000, +pins, ref);
  }

  cas(operationId, payload, expectedRevision) {
    if (
      !operationIdPattern.test(operationId) ||
      !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
    ) {
      fail('INVALID_COMMAND');
    }
    const payloadHash = hash(JSON.stringify(payload));
    const existing = this.db.prepare('SELECT * FROM operations WHERE id=?').get(operationId);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        fail('ID_CONFLICT');
      }
      return existing;
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const update = this.db.prepare(
        'UPDATE manifests SET revision=revision+1 WHERE ref=? AND revision=?',
      ).run(payload.ref, expectedRevision);
      if (!update.changes) {
        fail('CAS_CONFLICT');
      }
      this.db.prepare('INSERT INTO operations VALUES(?,?,?)')
        .run(operationId, payloadHash, expectedRevision + 1);
      this.db.prepare(
        'INSERT INTO events(entity,revision,operationId,schemaVersion,payloadHash) VALUES(?,?,?,?,?)',
      ).run(payload.ref, expectedRevision + 1, operationId, 1, payloadHash);
      this.db.exec('COMMIT');
      return { revision: expectedRevision + 1 };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  gc(now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(
        "UPDATE manifests SET state='expired' WHERE pinned=0 AND retainUntil<=? " +
        'AND NOT EXISTS(SELECT 1 FROM pins WHERE pins.ref=manifests.ref)',
      ).run(now);
      for (const filename of fs.readdirSync(this.root + '/artifacts')) {
        const keep = this.db.prepare(
          "SELECT 1 FROM manifests WHERE sha=? AND state='published'",
        ).get(filename);
        if (!keep) {
          fs.rmSync(this.root + '/artifacts/' + filename, { force: true });
        }
      }
      this.db.prepare("UPDATE manifests SET state='reclaimed' WHERE state='expired'").run();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.db.close();
  }
}
