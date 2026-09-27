'use client';
import {useRouter} from 'next/navigation';
import {Field,api,useBusy} from '../client-tools';
import {ErrorNote} from '../ui';
export function Login(){const work=useBusy(),router=useRouter();return <section className="login-sheet"><h1>관리자 로그인</h1><form onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void work.run(async()=>{await api('/api/auth/login',{method:'POST',body:JSON.stringify({email:f.get('email'),password:f.get('password')})});router.replace('/admin');router.refresh()})}}><Field label="이메일" type="email" name="email" autoComplete="username" required maxLength={254}/><Field label="비밀번호" type="password" name="password" autoComplete="current-password" required maxLength={256}/><ErrorNote message={work.error}/><button className="btn primary" disabled={work.busy}>{work.busy?'확인 중…':'로그인'}</button></form></section>}
