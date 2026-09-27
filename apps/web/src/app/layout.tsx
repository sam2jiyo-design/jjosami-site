import type {Metadata,Viewport} from 'next';
import {headers} from 'next/headers';
import {initialProfile} from '@jjosami/shared';
import {readSite} from '@/server/read';
import {External} from '@/components/ui';
import {Header,MotionProvider,NavLink} from '@/components/navigation';
import '@/styles/design.css';
import '@/styles/site.css';
export const metadata:Metadata={title:{default:'쪼삼이',template:'%s · 쪼삼이'},description:'쪼삼이의 프로필, 방송 일정, 시그풍, 노래책과 방셀 신청.'};
export const dynamic='force-dynamic';
export const viewport:Viewport={width:'device-width',initialScale:1,colorScheme:'light dark'};
export default async function RootLayout({children}:{children:React.ReactNode}){const nonce=(await headers()).get('x-nonce')||undefined;const site=await readSite().catch(()=>null),profile=site?.profile||initialProfile;return <html lang="ko" data-scroll-behavior="smooth" suppressHydrationWarning><head><script nonce={nonce} dangerouslySetInnerHTML={{__html:`try{var t=localStorage.getItem('jjosami-theme');document.documentElement.dataset.theme=t==='light'||t==='dark'?t:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}catch{document.documentElement.dataset.theme=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}`}}/></head><body className="milk"><a className="skip" href="#main-content">본문으로 바로가기</a><div className="container"><MotionProvider header={<Header name={profile.name}/>} footer={<footer className="site-footer"><span>{profile.name} © {new Date().getFullYear()}</span><div className="footer-links"><External href={profile.channel} soop>SOOP 방송국</External><NavLink href="/admin">관리자</NavLink></div></footer>}>{children}</MotionProvider></div></body></html>}
