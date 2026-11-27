import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, Code2, Copy, Download, Eye } from 'lucide-react'
import { toast } from 'sonner'
import { fmtExpiresAt, fmtNum } from '@/lib/format'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { StatusMark } from '@/components/status-mark'
import {
  fmtDurationSec,
  IQ_BENCHMARK_LABELS,
  iqStatusTone,
  wrapPreviewHtmlWithCsp,
} from './format'
import { vmIqArtifactQueryOptions } from './queries'

export function IqPreviewDialog({
  vmId,
  vmName,
  open,
  onOpenChange,
}: {
  vmId: string
  vmName?: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [copied, setCopied] = useState(false)
  const query = useQuery({
    ...vmIqArtifactQueryOptions(vmId),
    enabled: open && Boolean(vmId),
  })
  const artifact = query.data?.artifact ?? null
  const isHtml = artifact?.kind === 'html' && Boolean(artifact.html)
  const wrappedHtml = isHtml ? wrapPreviewHtmlWithCsp(artifact.html || '') : ''

  const copySource = async () => {
    const content = isHtml ? artifact?.html || '' : artifact?.answer || ''
    if (!content) return
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
      toast.success(isHtml ? '已复制 HTML 源码' : '已复制模型回答')
    } catch {
      toast.error('复制失败')
    }
  }

  const downloadHtml = () => {
    if (!artifact?.html) return
    const blob = new Blob([artifact.html], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `manxue-${vmId}-${artifact.benchmark}.html`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className='flex max-h-[88vh] flex-col gap-3 sm:max-w-4xl'
        onClick={(e) => e.stopPropagation()}
      >
        <DialogHeader>
          <div className='flex flex-wrap items-center justify-between gap-2 pr-6'>
            <DialogTitle className='flex items-center gap-2 text-base'>
              <span>测智结果预览 · {vmName || vmId}</span>
              {artifact ? (
                <StatusMark
                  tone={iqStatusTone(artifact.status, {
                    referenceOnly: artifact.reference_only,
                  })}
                  variant='pill'
                />
              ) : null}
            </DialogTitle>
            {artifact ? (
              <div className='flex items-center gap-1.5'>
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  className='h-7 gap-1 px-2 text-xs'
                  onClick={() => void copySource()}
                >
                  {copied ? (
                    <Check className='size-3.5' />
                  ) : (
                    <Copy className='size-3.5' />
                  )}
                  {isHtml ? '复制源码' : '复制回答'}
                </Button>
                {isHtml ? (
                  <Button
                    type='button'
                    size='sm'
                    variant='outline'
                    className='h-7 gap-1 px-2 text-xs'
                    onClick={downloadHtml}
                  >
                    <Download className='size-3.5' />
                    下载 HTML
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
          {artifact ? (
            <DialogDescription className='flex flex-wrap items-center gap-x-3 gap-y-1 text-xs'>
              <span>{IQ_BENCHMARK_LABELS[artifact.benchmark]}</span>
              <span className='font-mono'>{artifact.model}</span>
              {artifact.reasoning_effort ? (
                <span className='font-mono'>
                  effort={artifact.reasoning_effort}
                </span>
              ) : null}
              <span>耗时 {fmtDurationSec(artifact.duration_ms)}</span>
              {artifact.input_tokens != null ||
              artifact.output_tokens != null ? (
                <span className='font-mono'>
                  in {fmtNum(artifact.input_tokens ?? 0)} / out{' '}
                  {fmtNum(artifact.output_tokens ?? 0)}
                </span>
              ) : null}
              <span>{fmtExpiresAt(artifact.checked_at)}</span>
            </DialogDescription>
          ) : (
            <DialogDescription className='text-xs'>
              读取该 GPT 槽位最近一次 manxue.ai 测智产物
            </DialogDescription>
          )}
        </DialogHeader>

        {query.isPending ? (
          <div className='h-72 animate-pulse rounded-md bg-muted' />
        ) : query.isError ? (
          <div className='rounded-md border border-destructive/30 bg-destructive/5 p-4 text-xs text-destructive'>
            加载预览失败：{(query.error as Error).message}
          </div>
        ) : !artifact ? (
          <div className='rounded-md border p-6 text-center text-xs text-muted-foreground'>
            暂无可预览的测智产物
          </div>
        ) : (
          <div className='flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden'>
            {artifact.reason ? (
              <div className='rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground'>
                <span className='font-medium text-foreground'>判定说明：</span>
                {artifact.reason}
                {artifact.source ? (
                  <span className='ml-2 font-mono text-[11px] opacity-75'>
                    ({artifact.source})
                  </span>
                ) : null}
              </div>
            ) : null}

            {isHtml ? (
              <Tabs
                defaultValue='preview'
                className='flex min-h-0 flex-1 flex-col'
              >
                <TabsList className='w-fit'>
                  <TabsTrigger value='preview' className='gap-1.5 text-xs'>
                    <Eye className='size-3.5' />
                    动画预览
                  </TabsTrigger>
                  <TabsTrigger value='source' className='gap-1.5 text-xs'>
                    <Code2 className='size-3.5' />
                    HTML 源码
                  </TabsTrigger>
                </TabsList>
                <TabsContent
                  value='preview'
                  className='mt-2 flex-1 overflow-hidden rounded-md border bg-zinc-950'
                >
                  <iframe
                    title={`${vmName || vmId} 测智动画预览`}
                    sandbox='allow-scripts'
                    referrerPolicy='no-referrer'
                    srcDoc={wrappedHtml}
                    className='h-[440px] w-full border-0 bg-zinc-950'
                  />
                </TabsContent>
                <TabsContent
                  value='source'
                  className='mt-2 min-h-0 flex-1 overflow-auto rounded-md border bg-muted/30 p-3'
                >
                  <pre className='max-h-[440px] font-mono text-[11.5px] leading-relaxed break-all whitespace-pre-wrap'>
                    {artifact.html}
                  </pre>
                </TabsContent>
              </Tabs>
            ) : (
              <div className='min-h-0 flex-1 overflow-auto rounded-md border bg-muted/30 p-3'>
                <div className='mb-1.5 text-[11px] font-medium text-muted-foreground'>
                  模型回答（糖果检测）
                </div>
                <pre className='max-h-[420px] font-sans text-xs leading-relaxed whitespace-pre-wrap'>
                  {artifact.answer || '（无回答正文）'}
                </pre>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
