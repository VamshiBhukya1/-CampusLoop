import mysql from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

const definitions = {
  User: { table:'users', json:[], columns:['name','email','passwordHash','role','status','maxLoans','loanLockUntil'], foreign:{} },
  Resource: { table:'resources', json:['operatingHours'], columns:['name','type','category','description','assetId','isbn','author','location','capacity','status','totalCopies','availableCopies','reservationLockUntil','archived','operatingHours'], foreign:{} },
  Asset: { table:'assets', json:[], columns:['resource','assetTag','qrToken','location','condition','status','currentBooking','createdBy'], foreign:{resource:'resources(id)',createdBy:'users(id)'} },
  Booking: { table:'bookings', json:[], columns:['user','resource','asset','kind','status','start','end','dueAt','issuedBy','checkedOutAt','returnedAt','returnCondition','reason'], foreign:{user:'users(id)',resource:'resources(id)',asset:'assets(id)',issuedBy:'users(id)'} },
  Notification: { table:'notifications', json:[], columns:['user','title','message','readAt','dedupeKey'], foreign:{user:'users(id)'} },
  Audit: { table:'audit_logs', json:['details'], columns:['actor','action','entityType','entityId','details','requestId'], foreign:{actor:'users(id)'}, timestamps:'created', immutable:true },
  Document: { table:'documents', json:[], columns:['title','description','filename','mimeType','size','fileKey','versionGroup','version','replacedBy','accessLevel','uploadedBy','archived'], foreign:{replacedBy:'documents(id)',uploadedBy:'users(id)'} },
  Incident: { table:'incidents', json:[], columns:['user','resource','description','status','resolution'], foreign:{user:'users(id)',resource:'resources(id)'} },
  WaitingListEntry: { table:'waiting_list_entries', json:[], columns:['user','resource','status','asset','offeredAt','expiresAt','offerKey'], foreign:{user:'users(id)',resource:'resources(id)',asset:'assets(id)'} },
  Maintenance: { table:'maintenance_records', json:[], columns:['asset','description','reportedAt','startedAt','completedAt','responsible','completionNotes','inspectionPassed','status'], foreign:{asset:'assets(id)',responsible:'users(id)'} },
  SystemSetting: { table:'system_settings', json:['value'], columns:['key','value'], foreign:{} },
  StudyResource: { table:'study_resources', json:[], columns:['title','description','subject','category','semester','keywords','filename','extension','mimeType','size','storageKey','uploadedBy','moderationStatus','moderationNotes','downloadsCount'], foreign:{uploadedBy:'users(id)'} },
  StudyBookmark: { table:'study_bookmarks', json:[], columns:['user','resource'], foreign:{user:'users(id)',resource:'study_resources(id)'} }
};
const qid = name => `\`${name}\``;
const toDb = value => value instanceof Date ? value : value === undefined ? null : value;
const schemaSql = [
  `CREATE TABLE IF NOT EXISTS users (id CHAR(36) PRIMARY KEY, name VARCHAR(120) NOT NULL, email VARCHAR(254) NOT NULL UNIQUE, passwordHash VARCHAR(255) NOT NULL, role ENUM('student','admin') NOT NULL DEFAULT 'student', status ENUM('active','suspended') NOT NULL DEFAULT 'active', maxLoans INT NOT NULL DEFAULT 3, loanLockUntil DATETIME(3) NULL, createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), INDEX idx_users_status(status), INDEX idx_users_created(createdAt)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS resources (id CHAR(36) PRIMARY KEY, name VARCHAR(255) NOT NULL, type ENUM('book','equipment','space') NOT NULL, category VARCHAR(255), description TEXT, assetId VARCHAR(120) UNIQUE, isbn VARCHAR(32), author VARCHAR(255), location VARCHAR(255), capacity INT, status ENUM('available','maintenance','damaged','lost','retired') NOT NULL DEFAULT 'available', totalCopies INT NOT NULL DEFAULT 1, availableCopies INT NOT NULL DEFAULT 1, reservationLockUntil DATETIME(3), archived BOOLEAN NOT NULL DEFAULT FALSE, operatingHours JSON, createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), INDEX idx_resources_type_archived(type,archived), INDEX idx_resources_name(name)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS assets (id CHAR(36) PRIMARY KEY, resource CHAR(36) NOT NULL, assetTag VARCHAR(80) NOT NULL UNIQUE, qrToken CHAR(36) NOT NULL UNIQUE, location VARCHAR(255), \`condition\` ENUM('good','fair','damaged','lost') NOT NULL DEFAULT 'good', status ENUM('available','reserved','checked_out','maintenance','damaged','lost','retired') NOT NULL DEFAULT 'available', currentBooking CHAR(36), createdBy CHAR(36), createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), CONSTRAINT fk_asset_resource FOREIGN KEY(resource) REFERENCES resources(id), CONSTRAINT fk_asset_creator FOREIGN KEY(createdBy) REFERENCES users(id), INDEX idx_assets_resource_status(resource,status), INDEX idx_assets_created(createdAt)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS bookings (id CHAR(36) PRIMARY KEY, \`user\` CHAR(36) NOT NULL, resource CHAR(36) NOT NULL, asset CHAR(36), kind ENUM('loan','space') NOT NULL, status ENUM('pending','processing','approved','rejected','active','completed','cancelled') NOT NULL DEFAULT 'pending', \`start\` DATETIME(3) NOT NULL, \`end\` DATETIME(3) NOT NULL, dueAt DATETIME(3), issuedBy CHAR(36), checkedOutAt DATETIME(3), returnedAt DATETIME(3), returnCondition VARCHAR(32), reason VARCHAR(500), createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), CONSTRAINT fk_book_user FOREIGN KEY(\`user\`) REFERENCES users(id), CONSTRAINT fk_book_resource FOREIGN KEY(resource) REFERENCES resources(id), CONSTRAINT fk_book_asset FOREIGN KEY(asset) REFERENCES assets(id), CONSTRAINT fk_book_issuer FOREIGN KEY(issuedBy) REFERENCES users(id), INDEX idx_book_owner_created(\`user\`,createdAt), INDEX idx_book_resource_window(resource,kind,status,\`start\`,\`end\`), INDEX idx_book_due(status,dueAt)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS notifications (id CHAR(36) PRIMARY KEY, \`user\` CHAR(36) NOT NULL, title VARCHAR(255), message TEXT, readAt DATETIME(3), dedupeKey VARCHAR(255), createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), CONSTRAINT fk_notification_user FOREIGN KEY(\`user\`) REFERENCES users(id), UNIQUE KEY uq_notification_dedupe(\`user\`,dedupeKey), INDEX idx_notification_created(\`user\`,createdAt)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS audit_logs (id CHAR(36) PRIMARY KEY, actor CHAR(36), action VARCHAR(120), entityType VARCHAR(120), entityId VARCHAR(120), details JSON, requestId CHAR(36), createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), CONSTRAINT fk_audit_actor FOREIGN KEY(actor) REFERENCES users(id) ON DELETE SET NULL, INDEX idx_audit_created(createdAt), INDEX idx_audit_entity(entityType,entityId)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS documents (id CHAR(36) PRIMARY KEY, title VARCHAR(255), description TEXT, filename VARCHAR(255), mimeType VARCHAR(120), size BIGINT, fileKey VARCHAR(255) NOT NULL, versionGroup CHAR(36), version INT NOT NULL DEFAULT 1, replacedBy CHAR(36), accessLevel ENUM('all','students','admin') NOT NULL DEFAULT 'all', uploadedBy CHAR(36), archived BOOLEAN NOT NULL DEFAULT FALSE, createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), CONSTRAINT fk_doc_replaced FOREIGN KEY(replacedBy) REFERENCES documents(id), CONSTRAINT fk_doc_uploader FOREIGN KEY(uploadedBy) REFERENCES users(id), INDEX idx_doc_version(versionGroup), INDEX idx_doc_active(archived,createdAt)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS incidents (id CHAR(36) PRIMARY KEY, \`user\` CHAR(36), resource CHAR(36), description TEXT, status VARCHAR(32) NOT NULL DEFAULT 'open', resolution VARCHAR(1000), createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), CONSTRAINT fk_incident_user FOREIGN KEY(\`user\`) REFERENCES users(id), CONSTRAINT fk_incident_resource FOREIGN KEY(resource) REFERENCES resources(id), INDEX idx_incident_status(status,createdAt)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS waiting_list_entries (id CHAR(36) PRIMARY KEY, \`user\` CHAR(36) NOT NULL, resource CHAR(36) NOT NULL, status ENUM('waiting','offered','accepting','accepted','declined','expired','fulfilled') NOT NULL DEFAULT 'waiting', activeEntryKey VARCHAR(80) GENERATED ALWAYS AS (CASE WHEN status IN ('waiting','offered') THEN CONCAT(\`user\`,':',resource) ELSE NULL END) STORED, asset CHAR(36), offeredAt DATETIME(3), expiresAt DATETIME(3), offerKey VARCHAR(255), createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), CONSTRAINT fk_wait_user FOREIGN KEY(\`user\`) REFERENCES users(id), CONSTRAINT fk_wait_resource FOREIGN KEY(resource) REFERENCES resources(id), CONSTRAINT fk_wait_asset FOREIGN KEY(asset) REFERENCES assets(id), UNIQUE KEY uq_wait_active(activeEntryKey), INDEX idx_wait_fifo(resource,status,createdAt), INDEX idx_wait_expiry(status,expiresAt), INDEX idx_wait_owner(\`user\`,status)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS maintenance_records (id CHAR(36) PRIMARY KEY, asset CHAR(36) NOT NULL, description TEXT NOT NULL, reportedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), startedAt DATETIME(3), completedAt DATETIME(3), responsible CHAR(36), completionNotes TEXT, inspectionPassed BOOLEAN, status ENUM('open','in_progress','completed') NOT NULL DEFAULT 'open', createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), CONSTRAINT fk_maint_asset FOREIGN KEY(asset) REFERENCES assets(id), CONSTRAINT fk_maint_responsible FOREIGN KEY(responsible) REFERENCES users(id), INDEX idx_maintenance_state(status,createdAt)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS system_settings (id CHAR(36) PRIMARY KEY, \`key\` VARCHAR(120) NOT NULL UNIQUE, value JSON, createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS study_resources (id CHAR(36) PRIMARY KEY, title VARCHAR(255) NOT NULL, description TEXT, subject VARCHAR(160) NOT NULL, category VARCHAR(160) NOT NULL, semester VARCHAR(40), keywords VARCHAR(1000), filename VARCHAR(255) NOT NULL, extension ENUM('pdf','docx','pptx','zip') NOT NULL, mimeType VARCHAR(120) NOT NULL, size BIGINT NOT NULL, storageKey CHAR(36) NOT NULL UNIQUE, uploadedBy CHAR(36) NOT NULL, moderationStatus ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending', moderationNotes VARCHAR(1000), downloadsCount INT UNSIGNED NOT NULL DEFAULT 0, createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), CONSTRAINT fk_study_uploader FOREIGN KEY(uploadedBy) REFERENCES users(id), INDEX idx_study_moderation(moderationStatus,createdAt), INDEX idx_study_subject(subject,category), INDEX idx_study_uploader(uploadedBy,createdAt)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS study_bookmarks (id CHAR(36) PRIMARY KEY, \`user\` CHAR(36) NOT NULL, resource CHAR(36) NOT NULL, createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), CONSTRAINT fk_study_bookmark_user FOREIGN KEY(\`user\`) REFERENCES users(id) ON DELETE CASCADE, CONSTRAINT fk_study_bookmark_resource FOREIGN KEY(resource) REFERENCES study_resources(id) ON DELETE CASCADE, UNIQUE KEY uq_study_bookmark(\`user\`,resource), INDEX idx_study_bookmark_user(\`user\`,createdAt)) ENGINE=InnoDB`
];

let pool;
const transactionContext=new AsyncLocalStorage();
const executor=()=>transactionContext.getStore()||getPool();
export function getPool() {
  if (!pool) {
    for (const key of ['DB_HOST','DB_USER','DB_NAME']) if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
    pool = mysql.createPool({host:process.env.DB_HOST,port:Number(process.env.DB_PORT)||3306,user:process.env.DB_USER,password:process.env.DB_PASSWORD||'',database:process.env.DB_NAME,waitForConnections:true,connectionLimit:Number(process.env.DB_POOL_SIZE)||10,queueLimit:0,timezone:'Z',ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:true}:undefined,decimalNumbers:true});
  }
  return pool;
}
export async function initializeDatabase() { const db=getPool(); for (const sql of schemaSql) await db.query(sql); }
export async function closeDatabase() { if(pool){const p=pool;pool=undefined;await p.end()} }
export async function withTransaction(fn) { const conn=await getPool().getConnection();try{await conn.beginTransaction();const out=await transactionContext.run(conn,()=>fn(conn));await conn.commit();return out}catch(e){await conn.rollback();throw e}finally{conn.release()} }

export function timestampColumns(definition) { return definition.timestamps==='created'?['createdAt']:['createdAt','updatedAt']; }
function columns(Model) { return ['id',...Model.definition.columns,...timestampColumns(Model.definition)]; }
function fieldName(key) { return key==='_id'?'id':key; }
function encode(Model,key,value) { if(value===undefined)return null;if(Model.definition.json.includes(key)&&value!==null)return JSON.stringify(value);return toDb(value); }
function decode(Model,row) { if(!row)return null;const out={...row,_id:row.id};delete out.id;for(const key of Model.definition.json)if(typeof out[key]==='string'){try{out[key]=JSON.parse(out[key])}catch{}}Object.defineProperty(out,'save',{enumerable:false,value:async()=>Model.save(out)});return out }
function condition(Model, filter={}, args=[]) {
  const parts=[];
  for(const [key,value] of Object.entries(filter||{})) {
    if(key==='$options')continue;
    if(key==='$or'||key==='$and') { const group=value.map(x=>`(${condition(Model,x,args)||'1=1'})`);parts.push(group.length?group.join(key==='$or'?' OR ':' AND '):'1=0');continue; }
    const col=fieldName(key);if(!columns(Model).includes(col))throw new Error(`Unsupported ${Model.name} field: ${key}`);
    const sql=qid(col);
    if(value&&typeof value==='object'&&!Array.isArray(value)&&!(value instanceof Date)) {
      for(const [op,v] of Object.entries(value)) {
        if(op==='$in'||op==='$nin'){const values=v||[];if(!values.length){parts.push(op==='$in'?'1=0':'1=1');continue}parts.push(`${sql} ${op==='$in'?'IN':'NOT IN'} (${values.map(()=>'?').join(',')})`);args.push(...values.map(x=>encode(Model,key,x)));}
        else if(op==='$exists'){parts.push(`${sql} IS ${v?'NOT ':''}NULL`)}
        else if(op==='$regex'){let pattern=String(v).replace(/\\(.)/g,'$1');const insensitive=value.$options?.includes('i');parts.push(`${sql} LIKE ? ${insensitive?'COLLATE utf8mb4_general_ci':''}`);args.push(`%${pattern}%`)}
        else {const map={$lt:'<',$lte:'<=',$gt:'>',$gte:'>=',$ne:'<>','$eq':'='};if(!(op in map))throw new Error(`Unsupported query operator: ${op}`);if(v===null&&op==='$ne')parts.push(`${sql} IS NOT NULL`);else{parts.push(`${sql} ${map[op]} ?`);args.push(encode(Model,key,v))}}
      }
    } else if(value===null)parts.push(`${sql} IS NULL`);else {parts.push(`${sql} = ?`);args.push(encode(Model,key,value))}
  }
  return parts.join(' AND ');
}
function updateValues(Model, update, inserting=false) {
  const values={};for(const [k,v] of Object.entries(update||{}))if(!k.startsWith('$'))values[k]=v;
  for(const [k,v] of Object.entries(update?.$set||{}))values[k]=v;
  if(inserting)for(const [k,v] of Object.entries(update?.$setOnInsert||{}))if(values[k]===undefined)values[k]=v;
  for(const [k,v] of Object.entries(update?.$inc||{}))values[k]=Number(values[k]||0)+Number(v);
  for(const k of Object.keys(update?.$unset||{}))values[k]=null;
  for(const k of Object.keys(values))if(!columns(Model).includes(fieldName(k)))throw new Error(`Unsupported ${Model.name} field: ${k}`);
  return values;
}

class SqlQuery {
 constructor(Model,filter,one=false){this.Model=Model;this.filter=filter;this.one=one;this.order='';this.offset=0;this.limitValue=null;this.projections=null;this.populates=[]}
 select(fields){if(typeof fields==='string'){const parts=fields.split(/\s+/).filter(Boolean);this.projections={exclude:parts.every(x=>x.startsWith('-')),fields:parts.map(x=>x.replace(/^-/,''))}}return this}
 sort(spec){if(spec){this.order=Object.entries(spec).map(([k,v])=>`${qid(fieldName(k))} ${Number(v)<0?'DESC':'ASC'}`).join(',')}return this}
 skip(n){this.offset=Math.max(0,Number(n)||0);return this}
 limit(n){this.limitValue=Math.max(0,Number(n)||0);return this}
 populate(path,projection){this.populates.push({path,projection});return this}
 lean(){return this}
 async exec(){const M=this.Model,db=executor(),args=[],where=condition(M,this.filter,args);let sql=`SELECT * FROM ${qid(M.definition.table)}${where?` WHERE ${where}`:''}${this.order?` ORDER BY ${this.order}`:''}`;if(this.one)sql+=' LIMIT 1';else if(this.limitValue!==null)sql+=` LIMIT ${this.limitValue} OFFSET ${this.offset}`;else if(this.offset)sql+=` LIMIT 18446744073709551615 OFFSET ${this.offset}`;const [rows]=await db.query(sql,args);let out=rows.map(r=>decode(M,r));if(this.projections){const {exclude,fields}=this.projections;out=out.map(row=>Object.fromEntries(Object.entries(row).filter(([k])=>k==='_id'||(exclude?!fields.includes(k):fields.includes(k)))))}if(this.populates.length)for(const item of out)for(const p of this.populates)await M.populate(item,p.path,p.projection);return this.one?(out[0]||null):out}
 then(resolve,reject){return this.exec().then(resolve,reject)}
}

class SqlUpdateQuery {
 constructor(Model,filter,update,options){this.Model=Model;this.filter=filter;this.update=update;this.options=options;this.populates=[];this.projection=null;this.order=options.sort||null}
 populate(path,projection){this.populates.push({path,projection});return this}
 select(fields){this.projection=fields;return this}
 sort(order){this.order=order;return this}
 async exec(){let query=this.Model.findOne(this.filter);if(this.order)query.sort(this.order);const before=await query;if(!before){if(this.options.upsert){await this.Model.updateOne(this.filter,this.update,{upsert:true});return this.Model.findOne(this.filter)}return null}const changed=await this.Model.updateOne({_id:before._id,...this.filter},this.update);if(!changed.modifiedCount)return null;let row=this.options.new?await this.Model.findById(before._id):before;if(this.projection)row=await this.Model.findById(before._id).select(this.projection);if(row)for(const p of this.populates)await this.Model.populate(row,p.path,p.projection);return row}
 then(resolve,reject){return this.exec().then(resolve,reject)}
}

export class SqlTable {
 constructor(name,definition){this.name=name;this.definition=definition;this.relations={}}
 populate(row,path,projection){return populate.call(this,row,path,projection)}
 find(filter={}){return new SqlQuery(this,filter)} findOne(filter={}){return new SqlQuery(this,filter,true)}
 findById(id){return this.findOne({_id:id})}
 async create(data){const values={...data};values._id=values._id||randomUUID();if(this.name==='Asset'){values.qrToken||=randomUUID();values.condition||='good';values.status||='available'}if(this.name==='User'){values.role||='student';values.status||='active';values.maxLoans??=3}if(this.name==='Resource'){values.status||='available';values.totalCopies??=1;values.availableCopies??=values.totalCopies;values.archived??=false}if(this.name==='Booking')values.status||='pending';if(this.name==='Document'){values.version??=1;values.accessLevel||='all';values.archived??=false}if(this.name==='WaitingListEntry')values.status||='waiting';if(this.name==='Maintenance')values.status||='open';const now=new Date(),timestamps=timestampColumns(this.definition);values.createdAt=values.createdAt||now;if(timestamps.includes('updatedAt'))values.updatedAt=now;else delete values.updatedAt;const keys=Object.keys(values).map(fieldName);const fields=keys.map(qid).join(',');const vals=Object.keys(values).map(k=>encode(this,k,values[k]));await executor().execute(`INSERT INTO ${qid(this.definition.table)} (${fields}) VALUES (${keys.map(()=>'?').join(',')})`,vals);return this.findById(values._id)}
 async insertMany(list){const out=[];for(const data of list)out.push(await this.create(data));return out}
 async exists(filter={}){return (await this.findOne(filter).select('_id'))?{_id:'exists'}:null}
 async countDocuments(filter={}){const args=[],where=condition(this,filter,args);const [[row]]=await executor().query(`SELECT COUNT(*) AS n FROM ${qid(this.definition.table)}${where?` WHERE ${where}`:''}`,args);return Number(row.n)}
 async updateOne(filter,update,options={}){if(this.definition.immutable)throw new Error(`${this.name} records are immutable`);let existing;if(options.upsert)existing=await this.findOne(filter);if(existing&&Object.keys(update?.$setOnInsert||{}).length&&!Object.keys(update?.$set||{}).length)return{modifiedCount:0,upsertedCount:0};const values=updateValues(this,update),keys=Object.keys(values);if(!keys.length){if(!options.upsert||existing)return{modifiedCount:0,upsertedCount:0};const data=updateValues(this,update,true);for(const [k,v]of Object.entries(filter))if(typeof v!=='object')data[k]=v;try{await this.create(data);return{modifiedCount:0,upsertedCount:1}}catch(error){if(error.code==='ER_DUP_ENTRY')return{modifiedCount:0,upsertedCount:0};throw error}}const sets=[],setArgs=[];for(const k of keys){const col=qid(fieldName(k));if(update?.$inc?.[k]!==undefined){sets.push(`${col}=${col}+?`);setArgs.push(Number(update.$inc[k]))}else{sets.push(`${col}=?`);setArgs.push(encode(this,k,values[k]))}}const whereArgs=[],where=condition(this,filter,whereArgs);const updatedAtSql=timestampColumns(this.definition).includes('updatedAt')?',updatedAt=CURRENT_TIMESTAMP(3)':'';const [r]=await executor().execute(`UPDATE ${qid(this.definition.table)} SET ${sets.join(',')}${updatedAtSql}${where?` WHERE ${where}`:''} LIMIT 1`,[...setArgs,...whereArgs]);if(!r.affectedRows&&options.upsert){if(existing||await this.exists(filter))return{modifiedCount:0,upsertedCount:0};const data=updateValues(this,update,true);for(const [k,v]of Object.entries(filter))if(typeof v!=='object')data[k]=v;try{await this.create(data);return{modifiedCount:0,upsertedCount:1}}catch(error){if(error.code==='ER_DUP_ENTRY')return{modifiedCount:0,upsertedCount:0};throw error}}return{modifiedCount:r.affectedRows,upsertedCount:0}}
 async updateMany(filter,update){const rows=await this.find(filter);let modifiedCount=0;for(const row of rows)modifiedCount+=(await this.updateOne({_id:row._id},update)).modifiedCount;return{modifiedCount}}
 findOneAndUpdate(filter,update,options={}){return new SqlUpdateQuery(this,filter,update,options)}
 findByIdAndUpdate(id,update,options={}){return this.findOneAndUpdate({_id:id},update,options)}
 async deleteOne(filter){if(this.definition.immutable)throw new Error(`${this.name} records are immutable`);const args=[],where=condition(this,filter,args);const [r]=await executor().execute(`DELETE FROM ${qid(this.definition.table)}${where?` WHERE ${where}`:''} LIMIT 1`,args);return{deletedCount:r.affectedRows}}
 async deleteMany(filter){const rows=await this.find(filter);let deletedCount=0;for(const row of rows)deletedCount+=(await this.deleteOne({_id:row._id})).deletedCount;return{deletedCount}}
 async save(doc){const {_id,...data}=doc;if(!_id)throw new Error('Cannot save a row without an id');await this.updateOne({_id},{$set:data});return this.findById(_id)}
}

async function populate(row,path,projection){const relation=this.relations[path];if(!relation||!row[path])return row;const [Model,foreign=path]=relation;const value=await Model.findById(row[path]);if(value&&projection){const keep=projection.split(/\s+/);for(const key of Object.keys(value))if(key!=='_id'&&!keep.includes(key))delete value[key]}row[path]=value;return row}
export const models=Object.fromEntries(Object.entries(definitions).map(([name,def])=>[name,new SqlTable(name,def)]));
const {User,Resource,Asset,Booking,Notification,Audit,Document,Incident,WaitingListEntry,Maintenance,SystemSetting,StudyResource,StudyBookmark}=models;
User.relations={};
Asset.relations={resource:[Resource],createdBy:[User]};
Booking.relations={resource:[Resource],user:[User],asset:[Asset]};
Document.relations={uploadedBy:[User],replacedBy:[Document]};
Incident.relations={resource:[Resource],user:[User]};
WaitingListEntry.relations={resource:[Resource],asset:[Asset]};
Maintenance.relations={asset:[Asset],responsible:[User]};
StudyResource.relations={uploadedBy:[User]};
StudyBookmark.relations={resource:[StudyResource]};

