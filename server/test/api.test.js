import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV='test';
process.env.JWT_ACCESS_SECRET='test-only-secret-for-campusloop-tests';
const {app,User,Audit,SystemSetting}=await import('../src/index.js');
const {default:request}=await import('supertest');
const {default:jwt}=await import('jsonwebtoken');
const {models,timestampColumns}=await import('../src/db.js');

async function withRegistrationStubs({exists,create,audit=async()=>({})},run){
  const original={exists:User.exists,create:User.create,audit:Audit.create};
  User.exists=exists;User.create=create;Audit.create=audit;
  try{return await run()}finally{User.exists=original.exists;User.create=original.create;Audit.create=original.audit}
}

test('health endpoint responds with the shared success envelope',async()=>{
  const response=await request(app).get('/api/health');
  assert.equal(response.status,200);
  assert.equal(response.body.success,true);
  assert.equal(response.body.data.status,'ok');
});
test('audit rows use only createdAt and remain append-only',async()=>{
  assert.deepEqual(timestampColumns(models.Audit.definition),['createdAt']);
  assert.equal(models.Audit.definition.immutable,true);
  for(const [name,model] of Object.entries(models))if(name!=='Audit')assert.deepEqual(timestampColumns(model.definition),['createdAt','updatedAt'],`${name} timestamp policy should match its table`);
  await assert.rejects(()=>Audit.updateOne({_id:'audit-id'},{$set:{action:'changed'}}),/immutable/);
  await assert.rejects(()=>Audit.deleteOne({_id:'audit-id'}),/immutable/);
});
test('student-only resource workflows require authentication',async()=>{
  const response=await request(app).get('/api/bookings');
  assert.equal(response.status,401);
  assert.equal(response.body.code,'UNAUTHENTICATED');
});
test('profile updates are authenticated and scoped to the current user',async()=>{
  const original={findById:User.findById,findOneAndUpdate:User.findOneAndUpdate,audit:Audit.create};
  const current={_id:'student-profile-1',name:'Before Name',email:'student@example.edu',role:'student',status:'active',maxLoans:3};
  let filter,changes;
  User.findById=()=>({select:async()=>current});
  User.findOneAndUpdate=async(f,u)=>{filter=f;changes=u.$set;return{...current,...changes}};
  Audit.create=async()=>({});
  try{
    const token=jwt.sign({sub:current._id},process.env.JWT_ACCESS_SECRET,{expiresIn:'1h'});
    const response=await request(app).patch('/api/auth/profile').set('Authorization',`Bearer ${token}`).send({name:'After Name'});
    assert.equal(response.status,200);
    assert.deepEqual(filter,{_id:current._id,status:'active'});
    assert.deepEqual(changes,{name:'After Name'});
    assert.equal(response.body.data.user.email,current.email);
    assert.equal(response.body.data.user.passwordHash,undefined);
    const invalid=await request(app).patch('/api/auth/profile').set('Authorization',`Bearer ${token}`).send({name:'X',role:'admin'});
    assert.equal(invalid.status,400);
  }finally{User.findById=original.findById;User.findOneAndUpdate=original.findOneAndUpdate;Audit.create=original.audit}
});
test('logout clears the HttpOnly session cookie',async()=>{
  const response=await request(app).post('/api/auth/logout');
  assert.equal(response.status,200);
  assert.match(response.headers['set-cookie']?.[0]||'',/cl_access=;/);
});
test('study resource library, uploads, bookmarks, and downloads require authentication',async()=>{
  for(const[method,path]of [['get','/api/study-resources'],['get','/api/study-resources/mine'],['get','/api/study-resources/bookmarks'],['post','/api/study-resources'],['post','/api/study-resources/not-an-id/bookmark'],['get','/api/study-resources/not-an-id/download']]){
    const response=await request(app)[method](path).send({});
    assert.equal(response.status,401,`${method.toUpperCase()} ${path} should require authentication`);
  }
  const response=await request(app).patch('/api/study-resources/not-an-id/moderation').send({status:'approved'});
  assert.equal(response.status,401);
});
test('authenticated students can read the active booking rules',async()=>{
  const original={findById:User.findById,findOne:SystemSetting.findOne,advance:process.env.BOOKING_ADVANCE_DAYS,duration:process.env.MAX_BOOKING_HOURS};
  process.env.BOOKING_ADVANCE_DAYS='17';process.env.MAX_BOOKING_HOURS='2.5';
  User.findById=id=>({select:async()=>({_id:id,role:'student',status:'active'})});SystemSetting.findOne=()=>({lean:async()=>null});
  try{const token=jwt.sign({sub:'student-1'},process.env.JWT_ACCESS_SECRET,{expiresIn:'1h'});const response=await request(app).get('/api/booking-rules').set('Authorization',`Bearer ${token}`);assert.equal(response.status,200);assert.deepEqual(response.body.data.bookingRules,{maxAdvanceDays:17,maxDurationHours:2.5,cancelNoticeHours:1})}
  finally{User.findById=original.findById;SystemSetting.findOne=original.findOne;if(original.advance===undefined)delete process.env.BOOKING_ADVANCE_DAYS;else process.env.BOOKING_ADVANCE_DAYS=original.advance;if(original.duration===undefined)delete process.env.MAX_BOOKING_HOURS;else process.env.MAX_BOOKING_HOURS=original.duration}
});
test('administrator audit endpoint rejects unauthenticated access',async()=>{
  const response=await request(app).get('/api/audit');
  assert.equal(response.status,401);
});
test('all administrator route families reject unauthenticated requests before database access',async()=>{
  const routes=[
    ['get','/api/users'],['patch','/api/users/not-an-id/status'],['post','/api/resources'],['patch','/api/resources/not-an-id'],['delete','/api/resources/not-an-id'],
    ['post','/api/bookings/not-an-id/decision'],['post','/api/bookings/not-an-id/checkout'],['post','/api/bookings/not-an-id/return'],
    ['post','/api/documents'],['post','/api/documents/not-an-id/replace'],['patch','/api/documents/not-an-id/archive'],
    ['patch','/api/incidents/not-an-id'],['get','/api/assets'],['post','/api/resources/not-an-id/assets'],['patch','/api/assets/not-an-id/status'],['get','/api/assets/not-an-id/qr'],
    ['post','/api/qr/not-a-token/action'],['get','/api/maintenance'],['post','/api/assets/not-an-id/maintenance'],['patch','/api/maintenance/not-an-id/complete'],
    ['get','/api/admin/settings'],['put','/api/admin/settings/booking-rules'],['post','/api/admin/jobs/reminders/run']
  ];
  for(const[method,path]of routes){const response=await request(app)[method](path).send({});assert.equal(response.status,401,`${method.toUpperCase()} ${path} should require authentication`)}
});
test('cookie-authenticated state changes reject a foreign request origin',async()=>{
  const response=await request(app).post('/api/auth/logout').set('Cookie','cl_access=forged').set('Origin','https://attacker.example');
  assert.equal(response.status,403);
  assert.equal(response.body.code,'CSRF_REJECTED');
});
test('registration validates input before persistence and never accepts an admin role field',async()=>{
  const response=await request(app).post('/api/auth/register').send({name:'A',email:'not-an-email',password:'123',role:'admin'});
  assert.equal(response.status,400);
  assert.equal(response.body.code,'VALIDATION_ERROR');
});
test('registration creates a normalized student account with a password hash',async()=>withRegistrationStubs({
  create:async values=>({_id:'student-1',...values,status:'active',maxLoans:3}),
  exists:async()=>null,
},async()=>{
  let created;
  const originalCreate=User.create;
  User.create=async values=>{created=values;return originalCreate(values)};
  try{
    const response=await request(app).post('/api/auth/register').send({name:'  Ada Student ',email:' ADA@EXAMPLE.EDU ',password:'a-long-student-password',role:'admin'});
    assert.equal(response.status,201);
    assert.equal(response.body.data.user.name,'Ada Student');
    assert.equal(response.body.data.user.email,'ada@example.edu');
    assert.equal(response.body.data.user.role,'student');
    assert.equal(response.body.data.user.passwordHash,undefined);
    assert.notEqual(created.passwordHash,'a-long-student-password');
    assert.equal(await (await import('bcryptjs')).default.compare('a-long-student-password',created.passwordHash),true);
  }finally{User.create=originalCreate}
}));
test('registration reports duplicate email without creating a user',async()=>withRegistrationStubs({
  exists:async()=>({_id:'existing'}),create:async()=>{throw new Error('must not create duplicate')},
},async()=>{
  const response=await request(app).post('/api/auth/register').send({name:'Ada Student',email:'ada@example.edu',password:'a-long-student-password'});
  assert.equal(response.status,409);
  assert.equal(response.body.code,'DUPLICATE_EMAIL');
  assert.match(response.body.message,/already registered/i);
}));
test('registration returns an actionable database unavailable error',async()=>withRegistrationStubs({
  exists:async()=>{const error=new Error('connection refused');error.code='ECONNREFUSED';throw error},create:async()=>{throw new Error('must not create')},
},async()=>{
  const response=await request(app).post('/api/auth/register').send({name:'Ada Student',email:'ada@example.edu',password:'a-long-student-password'});
  assert.equal(response.status,503);
  assert.equal(response.body.code,'DATABASE_UNAVAILABLE');
  assert.match(response.body.message,/DB_\* settings/);
}));
test('login verifies the password, returns a clean student profile, and sets an HttpOnly cookie',async()=>{
  const bcrypt=(await import('bcryptjs')).default,password='CampusLoop-login-test-password';
  const passwordHash=await bcrypt.hash(password,4),original={findOne:User.findOne,create:Audit.create};
  User.findOne=async()=>({_id:'student-login',name:'Login Student',email:'login@example.test',passwordHash,role:'student',status:'active',maxLoans:3});Audit.create=async()=>({});
  try{const response=await request(app).post('/api/auth/login').send({email:'LOGIN@example.test',password});assert.equal(response.status,200);assert.equal(response.body.data.user.email,'login@example.test');assert.equal(response.body.data.user.passwordHash,undefined);assert.match(response.headers['set-cookie'][0],/HttpOnly/i)}finally{User.findOne=original.findOne;Audit.create=original.create}
});
test('login rejects wrong passwords and reports missing fields',async()=>{
  const bcrypt=(await import('bcryptjs')).default,passwordHash=await bcrypt.hash('correct-password',4),original={findOne:User.findOne,create:Audit.create};
  User.findOne=async()=>({_id:'student-login',email:'login@example.test',passwordHash,role:'student',status:'active'});Audit.create=async()=>({});
  try{const bad=await request(app).post('/api/auth/login').send({email:'login@example.test',password:'wrong'});assert.equal(bad.status,401);assert.equal(bad.body.code,'INVALID_CREDENTIALS');const missing=await request(app).post('/api/auth/login').send({});assert.equal(missing.status,400);assert.equal(missing.body.code,'VALIDATION_ERROR')}finally{User.findOne=original.findOne;Audit.create=original.create}
});
test('expired JWTs and student access to admin routes are rejected',async()=>{
  const original=User.findById;User.findById=id=>({select:async()=>({_id:id,role:'student',status:'active'})});
  try{const expired=jwt.sign({sub:'student-1'},process.env.JWT_ACCESS_SECRET,{expiresIn:-1});const expiredResponse=await request(app).get('/api/auth/me').set('Authorization',`Bearer ${expired}`);assert.equal(expiredResponse.status,401);const token=jwt.sign({sub:'student-1'},process.env.JWT_ACCESS_SECRET,{expiresIn:'1h'});const denied=await request(app).get('/api/users').set('Authorization',`Bearer ${token}`);assert.equal(denied.status,403)}finally{User.findById=original}
});
