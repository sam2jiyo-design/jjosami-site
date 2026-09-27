'use client';
import {useState,useEffect} from 'react';
import {useRouter} from 'next/navigation';
import {api,useBusy} from '../client-tools';
import {ErrorNote,Icon} from '../ui';
import {ProfileEditor,CalendarEditor,SignatureEditor} from './content';
import {SongbookEditor} from './songs';
import {RequestManager,ObligationManager} from './operations';
import {Collector} from './collector';
const tabs=[['profile','프로필','user'],['calendar','캘린더','calendar'],['signatures','시그풍','balloon'],['songbook','노래책','music'],['requests','방셀 신청','camera'],['obligations','업보 시트','list'],['collector','룰렛 연동','refresh']] as const;
export function Admin({email}:{email:string}){const [tab,setTab]=useState('profile'),[notice,setNotice]=useState('');useEffect(()=>{let timer:ReturnType<typeof setTimeout>;const saved=()=>{setNotice('저장했습니다.');clearTimeout(timer);timer=setTimeout(()=>setNotice(''),4000)};window.addEventListener('site:saved',saved);return()=>{clearTimeout(timer);window.removeEventListener('site:saved',saved)}},[]);const router=useRouter(),work=useBusy();return <section className="admin-workspace"><header className="admin-heading"><div><h1>관리자</h1><p>{email}</p></div><button className="btn quiet" disabled={work.busy} onClick={()=>void work.run(async()=>{await api('/api/auth/logout',{method:'POST'});router.replace('/login');router.refresh()})}>로그아웃</button></header><ErrorNote message={work.error}/>{notice&&<div className="save-toast" role="status">{notice}</div>}<nav className="admin-tabs" aria-label="관리 메뉴">{tabs.map(([id,label,icon])=><button key={id} aria-current={tab===id?'page':undefined} onClick={()=>setTab(id)}><Icon name={icon}/>{label}</button>)}</nav><div className="admin-content" key={tab}>{tab==='profile'?<ProfileEditor/>:tab==='calendar'?<CalendarEditor/>:tab==='signatures'?<SignatureEditor/>:tab==='songbook'?<SongbookEditor/>:tab==='requests'?<RequestManager/>:tab==='obligations'?<ObligationManager/>:<Collector/>}</div></section>}
