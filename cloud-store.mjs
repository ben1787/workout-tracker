import pg from 'pg';
import { randomBytes, randomUUID, createHash, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(derive);
export const digest = text => createHash('sha256').update(text).digest('hex');
export const fail = (status, message) => Object.assign(new Error(message), {status});
const stores = new Set(['plans', 'workouts', 'goals', 'exercises']);
export function createCloudStore(connectionString, {secure = true} = {}) {
  const pool = new pg.Pool({connectionString, max: 5, ...(process.env.DATABASE_SSL === 'true' ? {ssl: {rejectUnauthorized: true, ...(process.env.DATABASE_SSL_CA ? {ca: process.env.DATABASE_SSL_CA} : {})}} : {})});
  const ready = pool.query(`
    CREATE TABLE IF NOT EXISTS app_users (id uuid PRIMARY KEY, email text UNIQUE NOT NULL, password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS app_sessions (token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL);
    CREATE TABLE IF NOT EXISTS app_records (user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE, kind text NOT NULL, id text NOT NULL, data jsonb NOT NULL, revision bigint NOT NULL DEFAULT 1, PRIMARY KEY(user_id,kind,id));
    CREATE TABLE IF NOT EXISTS app_bootstrap (id integer PRIMARY KEY CHECK (id=1), data jsonb NOT NULL);
  `);
  const cookie = token => `workout_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token ? 2592000 : 0}${secure ? '; Secure' : ''}`;
  const hashPassword = async password => { const salt=randomBytes(16).toString('hex'); return `${salt}:${Buffer.from(await scrypt(password,salt,64)).toString('hex')}`; };
  const checkPassword = async (password, hash) => { const [salt, expected] = hash.split(':'); const actual=await scrypt(password,salt,64); return timingSafeEqual(Buffer.from(expected,'hex'),actual); };
  const record = row => row ? {...row.data, _serverRevision:Number(row.revision)} : null;
  const validateRecord = (data, kind) => {
    if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.id !== 'string' || !data.id.trim() || data.id.length>400) throw fail(400,'Every record needs a valid ID.');
    if(kind==='workouts' && (!data.day || !Array.isArray(data.sections) || !Number.isFinite(data.startedAt) || !Number.isFinite(data.endedAt))) throw fail(400,'Invalid workout record.');
    if(kind==='plans' && !Array.isArray(data.days)) throw fail(400,'Invalid plan record.');
    if(kind==='goals' && (typeof data.title!=='string' || !data.title.trim() || typeof data.active!=='boolean')) throw fail(400,'Invalid goal record.');
    if(kind==='exercises' && (typeof data.name!=='string' || !data.name.trim() || typeof data.instructions!=='string' || !['reps','hold','distance','time'].includes(data.measurement))) throw fail(400,'Invalid exercise record.');
    const clean=structuredClone(data); delete clean._serverRevision; return clean;
  };
  async function transaction(fn) { await ready; const client=await pool.connect(); try {await client.query('BEGIN'); const result=await fn(client); await client.query('COMMIT'); return result;} catch(e) {await client.query('ROLLBACK'); throw e;} finally {client.release();} }
  async function append(client,userId,data) {
    if (!data || !Array.isArray(data.plans) || !Array.isArray(data.workouts)) throw fail(400,'Backup needs plans and workouts arrays.');
    const counts={plans:0,workouts:0,goals:0,exercises:0,skipped:0};
    for (const kind of stores) {
      if (data[kind] !== undefined && !Array.isArray(data[kind])) throw fail(400,'Invalid backup records.');
      for (const value of data[kind] || []) {
        const clean=validateRecord(value,kind);
        const result=await client.query('INSERT INTO app_records(user_id,kind,id,data) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[userId,kind,clean.id,clean]);
        if (result.rowCount) counts[kind]++; else counts.skipped++;
      }
    }
    return counts;
  }
  async function authenticate(req) {
    await ready;
    const token=/\bworkout_session=([a-f0-9]{64})\b/.exec(req.headers.cookie || '')?.[1];
    if (!token) return null;
    const result=await pool.query('SELECT u.id,u.email FROM app_sessions s JOIN app_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()',[digest(token)]);
    return result.rows[0] || null;
  }
  async function issue(user) {
    const token=randomBytes(32).toString('hex');
    await pool.query('DELETE FROM app_sessions WHERE expires_at<now()');
    await pool.query("INSERT INTO app_sessions VALUES($1,$2,now()+interval '30 days')",[digest(token),user.id]);
    return {user, cookie:cookie(token)};
  }
  async function login({email,password}) {
    await ready;
    if (typeof email!=='string' || typeof password!=='string' || password.length>256 || email.length>320) throw fail(400,'Enter your email and password.');
    const found=await pool.query('SELECT id,email,password_hash FROM app_users WHERE email=$1',[email.trim().toLowerCase()]);
    // Scrypt also runs for unknown accounts to reduce account-discovery timing.
    const hash=found.rows[0]?.password_hash || `${'0'.repeat(32)}:${'0'.repeat(128)}`;
    if (!(await checkPassword(password,hash)) || !found.rows.length) throw fail(401,'Email or password is incorrect.');
    return issue({id:found.rows[0].id,email:found.rows[0].email});
  }
  function checkInvite(value) {if (!process.env.SETUP_TOKEN || typeof value!=='string' || digest(value)!==digest(process.env.SETUP_TOKEN)) throw fail(403,'This setup link is invalid.');}
  async function register({email,password,invite}) {
    checkInvite(invite);
    if (typeof email!=='string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length>320 || typeof password!=='string' || password.length<12 || password.length>256) throw fail(400,'Use a valid email and a password with at least 12 characters.');
    const passwordHash=await hashPassword(password);
    const user=await transaction(async client=>{
      await client.query("SELECT pg_advisory_xact_lock(8765001)");
      if ((await client.query('SELECT 1 FROM app_users LIMIT 1')).rows.length) throw fail(409,'This personal app is already set up. Please sign in.');
      const user={id:randomUUID(),email:email.trim().toLowerCase()};
      await client.query('INSERT INTO app_users(id,email,password_hash) VALUES($1,$2,$3)',[user.id,user.email,passwordHash]);
      const bootstrap=await client.query('SELECT data FROM app_bootstrap WHERE id=1');
      if (bootstrap.rows[0]) await append(client,user.id,bootstrap.rows[0].data);
      await client.query('DELETE FROM app_bootstrap');
      return user;
    });
    return issue(user);
  }
  return {ready,pool,authenticate,login,register,
    async isSetup() {await ready; return !!(await pool.query('SELECT 1 FROM app_users LIMIT 1')).rows.length;},
    async bootstrap({invite,data}) {checkInvite(invite); return transaction(async c=>{await c.query('SELECT pg_advisory_xact_lock(8765001)'); if ((await c.query('SELECT 1 FROM app_users LIMIT 1')).rows.length) throw fail(409,'Already set up. Import from History instead.'); if (!data || !Array.isArray(data.plans) || !Array.isArray(data.workouts)) throw fail(400,'Invalid backup.'); for(const kind of stores) for(const item of data[kind]||[]) validateRecord(item,kind); await c.query('INSERT INTO app_bootstrap VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data',[data]); return {sessions:data.workouts.length,goals:(data.goals||[]).length};});},
    async logout(req) {const token=/\bworkout_session=([a-f0-9]{64})\b/.exec(req.headers.cookie||'')?.[1]; if(token) await pool.query('DELETE FROM app_sessions WHERE token_hash=$1',[digest(token)]); return cookie('');},
    async list(user,kind,id) {if(!stores.has(kind)) throw fail(404,'Unknown record type.'); const values=[user.id,kind]; if(id) values.push(id); const result=await pool.query(`SELECT data,revision FROM app_records WHERE user_id=$1 AND kind=$2${id?' AND id=$3':''}` ,values); return id?record(result.rows[0]):result.rows.map(record);},
    async save(user,kind,data,expectedResultsRevision) {
      if(!stores.has(kind)) throw fail(404,'Unknown record type.'); const clean=validateRecord(data,kind);
      return transaction(async client=>{
        // Serialize mutations to an account, including new rows and imports.
        await client.query('SELECT id FROM app_users WHERE id=$1 FOR UPDATE',[user.id]);
        const current=(await client.query('SELECT data,revision FROM app_records WHERE user_id=$1 AND kind=$2 AND id=$3',[user.id,kind,clean.id])).rows[0];
        if(expectedResultsRevision!==undefined && (!current || (current.data.resultsRevision||0)!==expectedResultsRevision)) return {saved:false};
        if(current && Number(data._serverRevision)!==Number(current.revision)) throw fail(409,'This record changed on another device. Reload before editing it again.');
        if(!current && data._serverRevision != null) throw fail(409,'This record was deleted on another device. Reload before continuing.');
        const result=await client.query('INSERT INTO app_records(user_id,kind,id,data) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,kind,id) DO UPDATE SET data=EXCLUDED.data,revision=app_records.revision+1 RETURNING data,revision',[user.id,kind,clean.id,clean]);
        return {saved:true,record:record(result.rows[0])};
      });
    },
    async saveGeneratedExercises(user, exercises) {
      const records = exercises.map(item=>validateRecord(item,'exercises'));
      await transaction(async client=>{
        await client.query('SELECT id FROM app_users WHERE id=$1 FOR UPDATE',[user.id]);
        for (const incoming of records) {
          const current=(await client.query("SELECT data FROM app_records WHERE user_id=$1 AND kind='exercises' AND id=$2",[user.id,incoming.id])).rows[0]?.data;
          // AI enriches missing metadata; it never overwrites another device's
          // technique, name, aliases or an already saved demonstration.
          const merged=current ? {...current,...(!current.youtubeUrl && incoming.youtubeUrl ? {youtubeUrl:incoming.youtubeUrl} : {})} : incoming;
          if (current && JSON.stringify(merged)===JSON.stringify(current)) continue;
          await client.query("INSERT INTO app_records(user_id,kind,id,data) VALUES($1,'exercises',$2,$3) ON CONFLICT(user_id,kind,id) DO UPDATE SET data=EXCLUDED.data,revision=app_records.revision+1",[user.id,incoming.id,merged]);
        }
      });
    },
    async remove(user,kind,id,revision) {if(!stores.has(kind)) throw fail(404,'Unknown record type.'); const result=await pool.query('DELETE FROM app_records WHERE user_id=$1 AND kind=$2 AND id=$3 AND revision=$4',[user.id,kind,id,revision]); if(!result.rowCount) throw fail(409,'This record changed on another device. Reload before deleting it.'); return {deleted:true};},
    async import(user,data) {return transaction(async client=>{await client.query('SELECT id FROM app_users WHERE id=$1 FOR UPDATE',[user.id]); return append(client,user.id,data);});},
    async health() {await ready; await pool.query('SELECT 1');},
    async close() {await pool.end();}
  };
}
