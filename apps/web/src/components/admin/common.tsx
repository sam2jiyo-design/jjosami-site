'use client';
import {useState,type ReactNode} from 'react';
import {Check,Field,Select,api,useBusy} from '../client-tools';
import {ErrorNote} from '../ui';
export type PageData<T>={rows:T[];total:number;page:number;size:number};
export type ObligationType={id:string;name:string;unit:string;integer_only:boolean;active:boolean};
export const when=(s:string|null|undefined)=>s?new Date(s).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'—';
export function Actions({busy,onClose,label='저장'}:{busy:boolean;onClose?:()=>void;label?:string}){return <div className="editor-actions"><button className="btn primary" disabled={busy}>{busy?'저장 중…':label}</button>{onClose&&<button className="btn quiet" type="button" onClick={onClose} disabled={busy}>취소</button>}</div>}
export function ImageUpload({url,onChange}:{url?:string;onChange:(asset:{id:string;url:string})=>void}){const work=useBusy();return <div className="image-upload">{url&&<img src={url} alt="선택한 이미지"/>}<Field label="이미지 업로드" type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={work.busy} onChange={e=>{const file=e.target.files?.[0];if(!file)return;void work.run(async()=>{if(file.size>3145728)throw Error('3MB 이하의 파일을 선택해 주세요.');const body=new FormData();body.set('file',file);onChange(await api('/api/admin/assets',{method:'POST',body}))})}}/><span className="help-text">JPEG · PNG · WebP · GIF / 최대 3MB</span><ErrorNote message={work.error}/></div>}
export function Editor({children,busy,onSave}:{children:ReactNode;busy:boolean;onSave:()=>Promise<void>|void}){return <form className="admin-editor" onSubmit={e=>{e.preventDefault();if(!busy)void onSave()}}><fieldset disabled={busy}>{children}</fieldset></form>}
export function TypeSelect({types,value,onChange,optional=false}:{types:ObligationType[];value:string;onChange:(s:string)=>void;optional?:boolean}){return <Select label="업보 항목" value={value} onChange={e=>onChange(e.target.value)} required={!optional}><option value="">{optional?'선택 안 함':'항목 선택'}</option>{types.map(t=><option key={t.id} value={t.id}>{t.name} · {t.unit}{t.active?'':' (사용 중지)'}</option>)}</Select>}
export function Visibility({value,onChange}:{value:boolean;onChange:(v:boolean)=>void}){return <Check label="공개" checked={value} onChange={e=>onChange(e.target.checked)}/>}
export function Confirm({label,checked,onChange}:{label:string;checked:boolean;onChange:(b:boolean)=>void}){return <div className="confirm-line"><Check label={label} checked={checked} onChange={e=>onChange(e.target.checked)}/></div>}
export function RefreshError({error,onRetry}:{error:string;onRetry:()=>void}){return error?<div><ErrorNote message={error}/><button className="btn quiet" onClick={onRetry}>다시 불러오기</button></div>:null}
