import { FormControl, FormControlLabel, FormLabel, Paper, Radio, RadioGroup, Stack, Typography } from '@mui/material';
import type { EndPeriod, InquiryRooms } from '../core/types';
import { BUILTIN_TEMPLATES, END_PERIOD_LABEL, INQUIRY_ROOMS_LABEL, csatSituation, csatTemplateId } from '../data/templates';

/**
 * 시험장 상황 두 가지를 물어 평가원 안내방송 유형(1~6)을 고른다.
 * 대본 안내: "4교시 탐구 선택과목 혼합시험실이 없고 5교시로 종료되는 시험장은 2)로 방송" 등
 */
export default function SituationPicker({ value, onChange }: { value: string; onChange: (templateId: string) => void }) {
  const cur = csatSituation(value) ?? { inquiry: 'split' as InquiryRooms, end: 5 as EndPeriod };
  const set = (inquiry: InquiryRooms, end: EndPeriod) => onChange(csatTemplateId(inquiry, end));
  const tpl = BUILTIN_TEMPLATES.find((t) => t.id === csatTemplateId(cur.inquiry, cur.end));
  const endKeys: EndPeriod[] = [4, 5, 'mixed'];

  return (
    <Stack spacing={1.5}>
      <Paper variant="outlined" sx={{ px: 2, py: 1.25 }}>
        <FormControl>
          <FormLabel sx={{ fontWeight: 700, color: 'text.primary' }}>4교시 탐구 영역 시험실</FormLabel>
          <RadioGroup value={cur.inquiry} onChange={(e) => set(e.target.value as InquiryRooms, cur.end)}>
            {(Object.keys(INQUIRY_ROOMS_LABEL) as InquiryRooms[]).map((k) => (
              <FormControlLabel
                key={k}
                value={k}
                control={<Radio size="small" />}
                label={k === 'split' ? '1과목·2과목 선택자를 시험실별로 나눔 (혼합 시험실 없음)' : '1과목·2과목 선택자가 섞인 시험실이 있음'}
              />
            ))}
          </RadioGroup>
        </FormControl>
      </Paper>
      <Paper variant="outlined" sx={{ px: 2, py: 1.25 }}>
        <FormControl>
          <FormLabel sx={{ fontWeight: 700, color: 'text.primary' }}>시험장 종료 교시</FormLabel>
          <RadioGroup
            value={String(cur.end)}
            onChange={(e) => set(cur.inquiry, endKeys.find((k) => String(k) === e.target.value) ?? 5)}
          >
            {endKeys.map((k) => (
              <FormControlLabel
                key={k}
                value={String(k)}
                control={<Radio size="small" />}
                label={k === 'mixed' ? '4교시로 끝나는 시험실과 5교시까지 하는 시험실이 섞임' : `모든 시험실이 ${END_PERIOD_LABEL[k]}`}
              />
            ))}
          </RadioGroup>
        </FormControl>
      </Paper>
      {tpl && (
        <Typography variant="body2" color="text.secondary">
          → <strong>{tpl.name}</strong> (평가원 음원 {tpl.id.replace('csat-', '')}번 폴더)
        </Typography>
      )}
    </Stack>
  );
}
