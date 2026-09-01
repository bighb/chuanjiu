import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { glob } from 'astro/loaders';

// ── 枚举：改这里就等于改全站的筛选选项 ──
export const CATEGORIES = ['畜肉', '禽类', '内脏', '水产', '素菜', '豆制品', '主食'] as const;
export const HEAT_PROFILES = ['猛火快烤', '中火慢烤', '文火慢烤', '先猛后文'] as const;

// 一段散文 + 可选配图，复用于多个步骤
const photoFields = (image: any) => ({
  photo: image().optional(),
  photoAlt: z.string().optional(),
  photoHint: z.string().optional(), // 缺图时占位框里显示的拍摄建议
});

const bbq = defineCollection({
  loader: glob({ pattern: '**/[^_]*.md', base: './src/data/bbq' }),
  schema: ({ image }) =>
    z.object({
      // ══ 身份 ══
      name: z.string(), // 五花肉串
      category: z.enum(CATEGORIES),
      badge: z.string().optional(), // 镇摊之串 / 湖北代表
      summary: z.string(), // 卡片上那一句
      intro: z.string(), // 详情页标题下的导语，1–3 句
      order: z.number().default(100), // 索引排序，小的在前
      status: z.enum(['draft', 'verified']).default('draft'),
      updated: z.coerce.date().optional(),
      ...photoFields(image), // 成品特写

      // ══ 筛选维度（三个筛选器直接读这三个字段） ══
      marinate: z.enum(['required', 'none']),
      marinateMinutes: z.number().int().positive().optional(),
      heatProfile: z.enum(HEAT_PROFILES),

      // ══ 详情页头部关键参数条 ══
      specs: z
        .array(
          z.object({
            label: z.string(), // 改刀厚度
            value: z.string(), // 3 毫米
          })
        )
        .default([]),

      // ══ 01 取材 ══
      sourcing: z.object({
        body: z.string(),
        checks: z
          .array(
            z.object({
              title: z.string(), // 看层次
              body: z.string(),
            })
          )
          .default([]),
        ...photoFields(image),
      }),

      // ══ 02 穿串 ══
      skewering: z.object({
        body: z.string(),
        diagram: z.enum(['wave', 'flat', 'chunk', 'none']).default('none'),
        diagramNote: z.string().optional(),
        ...photoFields(image),
      }),

      // ══ 03 腌制 ══
      marinating: z.object({
        body: z.string(),
        basis: z.string().optional(), // 每 500 克
        recipe: z
          .array(
            z.object({
              name: z.string(), // 盐
              amount: z.string(), // 4 克
              purpose: z.string(), // 底味，宁少勿多
            })
          )
          .default([]),
        callout: z.string().optional(), // "为什么不放料酒" 这类补充说明
      }),

      // ══ 04 给料 ══
      seasoning: z.object({
        body: z.string().optional(),
        timeline: z
          .array(
            z.object({
              when: z.string(), // 上炉初期
              what: z.string(), // 什么都不加
              body: z.string(),
            })
          )
          .min(1),
      }),

      // ══ 05 火候 ══
      fire: z.object({
        body: z.string().optional(),
        stages: z
          .array(
            z.object({
              name: z.string(), // 猛火锁边
              duration: z.string(), // 1–2 分钟
              body: z.string(),
            })
          )
          .min(1),
        charcoal: z.string().optional(), // 用什么炭
        doneness: z.string().optional(), // 怎么判断熟了
        ...photoFields(image),
      }),

      // ══ 地方做法对比（可选） ══
      localVariants: z
        .object({
          wuhan: z.string().optional(),
          anlu: z.string().optional(),
        })
        .optional(),

      // ══ 常见翻车点 ══
      pitfalls: z
        .array(
          z.object({
            title: z.string(), // 切太厚
            body: z.string(),
          })
        )
        .default([]),
    })
    // ══ 跨字段一致性校验：把"卡片和详情页互相打架"挡在构建期 ══
    .superRefine((d, ctx) => {
      if (d.marinate === 'required') {
        if (d.marinateMinutes === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['marinateMinutes'],
            message: 'marinate 为 required 时必须填 marinateMinutes（卡片要显示"需腌制 N 分钟"）',
          });
        }
        if (d.marinating.recipe.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['marinating', 'recipe'],
            message: 'marinate 为 required 时 marinating.recipe 不能为空',
          });
        }
      } else {
        if (d.marinateMinutes !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['marinateMinutes'],
            message: 'marinate 为 none（免腌）时不应填 marinateMinutes',
          });
        }
      }
      // 四处图片位：有图就必须有 alt
      const slots: [string[], { photo?: unknown; photoAlt?: string }][] = [
        [[], d],
        [['sourcing'], d.sourcing],
        [['skewering'], d.skewering],
        [['fire'], d.fire],
      ];
      for (const [path, slot] of slots) {
        if (slot.photo && !slot.photoAlt) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, 'photoAlt'],
            message: '有 photo 就必须有 photoAlt',
          });
        }
      }
    }),
});

export const collections = { bbq };
