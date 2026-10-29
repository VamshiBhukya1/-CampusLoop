import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

process.env.NODE_ENV='test';
process.env.JWT_ACCESS_SECRET||='campusloop-integration-test-secret-not-for-production';
const hasTestDatabase=Boolean(process.env.DB_TEST_HOST&&process.env.DB_TEST_USER&&process.env.DB_TEST_NAME);
if(hasTestDatabase){process.env.DB_HOST=process.env.DB_TEST_HOST;process.env.DB_PORT=process.env.DB_TEST_PORT||'3306';process.env.DB_USER=process.env.DB_TEST_USER;process.env.DB_PASSWORD=process.env.DB_TEST_PASSWORD||'';process.env.DB_NAME=process.env.DB_TEST_NAME}
const testDatabase=process.env.DB_TEST_NAME;
const {app,models,connectDatabase,closeDatabase}=await import('../src/index.js');
const {default:request}=await import('supertest');
const origin=new URL(process.env.CLIENT_URL||'http://localhost:5173').origin;
after(async()=>{await closeDatabase()});

test('MySQL integration: auth, resource assets, borrowing, concurrency, QR, documents, ownership, audit, and reconnect persistence',{
  skip:!hasTestDatabase?'DB_TEST_HOST, DB_TEST_USER, and DB_TEST_NAME must point to a dedicated MySQL test database.':false
},async()=>{
  assert.match(testDatabase,/test/i,'DB_TEST_NAME must contain "test"');
  await connectDatabase();
  const password='CampusLoop-Integration-Password-2026';
  const adminUser=await models.User.create({name:'Test Admin',email:`admin-${Date.now()}@example.test`,passwordHash:await bcrypt.hash(password,4),role:'admin'});
  const admin=request.agent(app).set('Origin',origin);
  const student=request.agent(app).set('Origin',origin),otherStudent=request.agent(app).set('Origin',origin);
  const adminLogin=await admin.post('/api/auth/login').send({email:adminUser.email,password});
  assert.equal(adminLogin.status,200);
  const registration=await student.post('/api/auth/register').send({name:'Student One',email:`student-${Date.now()}@example.test`,password});
  assert.equal(registration.status,201);assert.equal(registration.body.data.user.role,'student');
  assert.equal((await student.post('/api/auth/login').send({email:registration.body.data.user.email,password})).status,200);
  const secondRegistration=await otherStudent.post('/api/auth/register').send({name:'Student Two',email:`student-two-${Date.now()}@example.test`,password});
  assert.equal(secondRegistration.status,201);
  assert.equal((await otherStudent.post('/api/auth/login').send({email:secondRegistration.body.data.user.email,password})).status,200);
  assert.equal((await student.post('/api/resources').send({name:'Role bypass',type:'book'})).status,403);

  const bookResponse=await admin.post('/api/resources').send({name:'Integration Book',type:'book',assetId:`IT-${Date.now()}`,totalCopies:1});
  assert.equal(bookResponse.status,201);const resource=bookResponse.body.data.resource;
  assert.equal(await models.Asset.countDocuments({resource:resource._id}),1);
  const resourceRead=await student.get(`/api/resources/${resource._id}`);assert.equal(resourceRead.status,200);
  const [asset]=await models.Asset.find({resource:resource._id});
  assert.equal((await student.get(`/api/qr/${asset.qrToken}`)).body.data.asset.assetTag,asset.assetTag);
  assert.equal((await request(app).post(`/api/qr/${asset.qrToken}/action`).send({action:'check-out'})).status,401);
  assert.equal((await student.post(`/api/qr/${asset.qrToken}/action`).send({action:'check-out'})).status,403);

  const loanStart=new Date(Date.now()+60_000).toISOString(),loanEnd=new Date(Date.now()+3_600_000).toISOString();
  const created=await student.post('/api/bookings').send({resourceId:String(resource._id),kind:'loan',start:loanStart,end:loanEnd});
  assert.equal(created.status,201);const bookingId=created.body.data.booking._id;
  assert.equal((await admin.post(`/api/bookings/${bookingId}/decision`).send({decision:'approved'})).status,200);
  assert.equal((await models.Asset.findById(asset._id)).status,'reserved');
  assert.equal((await admin.post(`/api/bookings/${bookingId}/checkout`).send({})).status,200);
  assert.equal((await admin.post(`/api/bookings/${bookingId}/return`).send({condition:'good'})).status,200);
  assert.equal((await models.Asset.findById(asset._id)).status,'available');
  assert.equal((await models.Resource.findById(resource._id)).availableCopies,1);
  assert.equal((await student.get('/api/bookings')).body.data.items[0].status,'completed');

  const room=(await admin.post('/api/resources').send({name:'Concurrency Room',type:'space',operatingHours:{}})).body.data.resource;
  const tomorrow=new Date(Date.now()+24*3600_000);tomorrow.setUTCHours(10,0,0,0);const start=tomorrow.toISOString(),end=new Date(tomorrow.getTime()+3600_000).toISOString();
  const concurrent=await Promise.all([student.post('/api/bookings').send({resourceId:String(room._id),kind:'space',start,end}),otherStudent.post('/api/bookings').send({resourceId:String(room._id),kind:'space',start,end})]);
  assert.equal(concurrent.filter(r=>r.status===201).length,1);assert.equal(concurrent.filter(r=>r.status===409).length,1);
  const roomBooking=concurrent.find(r=>r.status===201).body.data.booking;
  assert.equal((await admin.post(`/api/bookings/${roomBooking._id}/decision`).send({decision:'approved'})).status,200);
  assert.equal(await models.Booking.countDocuments({resource:room._id,status:'approved'}),1);

  const incident=await student.post('/api/incidents').send({resourceId:String(resource._id),description:'Integration test report'});
  assert.equal(incident.status,201);assert.equal((await otherStudent.get('/api/incidents')).body.data.items.length,0);
  const privateIncident=await admin.get('/api/incidents');assert.equal(privateIncident.status,200);
  const ownNotifications=(await student.get('/api/notifications')).body.data.items;
  assert.ok(ownNotifications.length>0);assert.equal((await otherStudent.get('/api/notifications')).body.data.items.length,0);

  const maintenance=await admin.post(`/api/assets/${asset._id}/maintenance`).send({description:'Test maintenance and inspection'});
  assert.equal(maintenance.status,201);assert.equal(maintenance.body.data.asset.status,'maintenance');
  const unavailable=await student.post('/api/bookings').send({resourceId:String(resource._id),kind:'loan',start:new Date(Date.now()+60_000).toISOString(),end:new Date(Date.now()+3_600_000).toISOString()});
  assert.equal(unavailable.status,409);
  const waitEntry=await student.post(`/api/resources/${resource._id}/waitlist`).send({});assert.equal(waitEntry.status,201);
  const inspected=await admin.patch(`/api/maintenance/${maintenance.body.data.record._id}/complete`).send({completionNotes:'Inspection passed',inspectionPassed:true,condition:'good'});
  assert.equal(inspected.status,200);assert.equal(inspected.body.data.asset.status,'reserved');
  const offered=(await student.get('/api/waitlist')).body.data.items.find(e=>String(e._id)===waitEntry.body.data.entry._id);
  assert.equal(offered.status,'offered');
  const accepted=await student.post(`/api/waitlist/${offered._id}/respond`).send({response:'accept'});assert.equal(accepted.status,200);
  const offeredBooking=accepted.body.data.booking._id;
  assert.equal((await admin.post(`/api/bookings/${offeredBooking}/checkout`).send({})).status,200);
  assert.equal((await admin.post(`/api/bookings/${offeredBooking}/return`).send({condition:'good'})).status,200);

  const pdf=Buffer.from('%PDF-1.4\nCampusLoop integration document\n%%EOF');
  const uploaded=await admin.post('/api/documents').field('title','Private test PDF').field('accessLevel','admin').attach('file',pdf,{filename:'test.pdf',contentType:'application/pdf'});
  assert.equal(uploaded.status,201);const documentId=uploaded.body.data.document.id;
  assert.equal((await student.get(`/api/documents/${documentId}/download`)).status,403);
  const shared=await admin.post('/api/documents').field('title','Student test PDF').field('accessLevel','students').attach('file',pdf,{filename:'student-test.pdf',contentType:'application/pdf'});
  assert.equal(shared.status,201);const sharedId=shared.body.data.document.id;
  const firstAudit=await admin.get('/api/audit');assert.ok(firstAudit.body.data.items.some(a=>a.action==='loan.return'));

  await closeDatabase();await connectDatabase();
  const persisted=await models.Document.findById(documentId);assert.ok(persisted);
  const userTokenLogin=request.agent(app).set('Origin',origin);const loginAgain=await userTokenLogin.post('/api/auth/login').send({email:adminUser.email,password});assert.equal(loginAgain.status,200);
  const adminDownload=await userTokenLogin.get(`/api/documents/${documentId}/download`).buffer(true).parse((response,callback)=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>callback(null,Buffer.concat(chunks)))});assert.equal(adminDownload.status,200);assert.equal(adminDownload.body.subarray(0,5).toString(),'%PDF-');
  const studentLogin=request.agent(app).set('Origin',origin);const studentLoginResult=await studentLogin.post('/api/auth/login').send({email:registration.body.data.user.email,password});assert.equal(studentLoginResult.status,200);
  const persistedDownload=await studentLogin.get(`/api/documents/${sharedId}/download`).buffer(true).parse((response,callback)=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>callback(null,Buffer.concat(chunks)))});assert.equal(persistedDownload.status,200);assert.equal(persistedDownload.body.subarray(0,5).toString(),'%PDF-');
  const reminderRequest=await student.post('/api/bookings').send({resourceId:String(resource._id),kind:'loan',start:new Date(Date.now()+60_000).toISOString(),end:new Date(Date.now()+3_600_000).toISOString()});
  assert.equal(reminderRequest.status,201);const reminderId=reminderRequest.body.data.booking._id;
  assert.equal((await admin.post(`/api/bookings/${reminderId}/decision`).send({decision:'approved'})).status,200);
  assert.equal((await admin.post(`/api/bookings/${reminderId}/checkout`).send({})).status,200);
  await models.Booking.updateOne({_id:reminderId},{$set:{dueAt:new Date(Date.now()+3600_000)}});
  const runs=await Promise.all([userTokenLogin.post('/api/admin/jobs/reminders/run'),userTokenLogin.post('/api/admin/jobs/reminders/run')]);
  assert.equal(runs.every(r=>r.status===200),true,'manual reminder job should be admin-accessible');
  assert.equal(await models.Notification.countDocuments({user:registration.body.data.user.id,dedupeKey:`loan:${reminderId}:due:${new Date(Date.now()+3600_000).toISOString().slice(0,10)}`}),1);
  await models.Booking.updateOne({_id:reminderId},{$set:{dueAt:new Date(Date.now()-60_000)}});
  const overdueBlocked=await student.post('/api/bookings').send({resourceId:String(resource._id),kind:'loan',start:new Date(Date.now()+60_000).toISOString(),end:new Date(Date.now()+3_600_000).toISOString()});
  assert.equal(overdueBlocked.status,409);assert.equal(overdueBlocked.body.code,'OVERDUE_BLOCK');
});
