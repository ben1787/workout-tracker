let hosted = false;
export const isHosted = () => hosted;
export async function cloudRequest(path, options = {}) {
  const response=await fetch(path,{...options, headers:{'Content-Type':'application/json',...options.headers},cache:'no-store'});
  const data=await response.json();
  if(!response.ok) throw new Error(data.error || 'Could not save to your account.');
  return data;
}
export async function requireAccount() {
  const response=await fetch('/api/auth/session',{cache:'no-store'});
  if(response.status===404) return; // Static legacy deployment, before migration.
  if(!response.ok) throw new Error('Could not connect to your account. Reload to retry.');
  const session=await response.json();
  hosted=session.cloud;
  if(!hosted) return;
  if(session.user) {
    // Setup links carry a one-time token in the fragment, never the request URL.
    if(location.hash.startsWith('#setup=')) history.replaceState(null,'',location.pathname);
    const bar=document.createElement('aside'); bar.className='account-bar';
    const label=document.createElement('span');label.textContent=`${session.user.email} · Saved to your account`;
    const refresh=document.createElement('button');refresh.textContent='Refresh';refresh.onclick=()=>location.reload();
    const logout=document.createElement('button');logout.textContent='Sign out';logout.onclick=async()=>{await cloudRequest('/api/auth/logout',{method:'POST',body:'{}'});location.reload();};
    bar.append(label,refresh,logout); document.body.prepend(bar); return;
  }
  const root=document.getElementById('app');root.replaceChildren();
  const heading=document.createElement('h1');heading.textContent=session.setupRequired?'Set up your workout account':'Welcome back';
  const description=document.createElement('p');description.textContent=session.setupRequired?'Choose your email and password. Your saved history will be waiting in your account.':'Sign in to see the same goals and workout history on every device.';
  const form=document.createElement('form');form.className='card col';form.setAttribute('aria-label',session.setupRequired?'Create account':'Sign in');
  const field=(name,type,autocomplete)=>{const label=document.createElement('label');label.className='col';label.textContent=name;const input=document.createElement('input');input.type=type;input.required=true;input.autocomplete=autocomplete;input.maxLength=type==='password'?256:320;label.append(input);form.append(label);return input;};
  const email=field('Email','email','username');
  const password=field('Password','password',session.setupRequired?'new-password':'current-password');
  if(session.setupRequired) password.minLength=12;
  const inviteFromLink=location.hash.startsWith('#setup=')?decodeURIComponent(location.hash.slice(7)):'';
  let invite;
  if(session.setupRequired && !inviteFromLink) {invite=field('Setup code','password','off');invite.removeAttribute('autocomplete');}
  const error=document.createElement('p');error.setAttribute('role','alert');
  const submit=document.createElement('button');submit.type='submit';submit.className='primary';submit.textContent=session.setupRequired?'Create my account':'Sign in';
  form.append(error,submit);
  form.onsubmit=async event=>{
    event.preventDefault();submit.disabled=true;error.textContent='';
    try {await cloudRequest(session.setupRequired?'/api/auth/register':'/api/auth/login',{method:'POST',body:JSON.stringify({email:email.value,password:password.value,invite:inviteFromLink||invite?.value})}); location.reload();}
    catch(e){error.textContent=e.message;submit.disabled=false;}
  };
  root.append(heading,description,form);
  // Wait for user-owned account setup/sign-in; never open local data as a fallback.
  await new Promise(()=>{});
}
