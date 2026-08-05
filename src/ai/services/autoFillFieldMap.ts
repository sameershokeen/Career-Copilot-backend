import type { ParsedResume } from "../types/index";

/**
 * Standard form fields we attempt to map on generic portals. Each entry is
 * a list of candidate selectors (common name/id/placeholder/aria-label
 * patterns seen across Greenhouse, Lever, Workday-lite, and generic HTML
 * forms), tried in order until one matches.
 */
export interface FieldTarget {
  field: string;
  value: string;
  selectors: string[];
}

/** Builds the standard-field -> value -> candidate-selector map for a resume. */
export function buildStandardFieldTargets(
  resume: ParsedResume,
  extra: { resumePdfUrl?: string | null; coverLetterText?: string | null },
): FieldTarget[] {
  const targets: FieldTarget[] = [
    {
      field: "full_name",
      value: resume.name,
      selectors: [
        'input[name*="name" i]',
        'input[id*="full_name" i]',
        'input[autocomplete="name"]',
        'input[placeholder*="full name" i]',
      ],
    },
    {
      field: "email",
      value: resume.email,
      selectors: [
        'input[type="email"]',
        'input[name*="email" i]',
        'input[autocomplete="email"]',
      ],
    },
    {
      field: "phone",
      value: resume.phone,
      selectors: [
        'input[type="tel"]',
        'input[name*="phone" i]',
        'input[autocomplete="tel"]',
      ],
    },
    {
      field: "linkedin",
      value: resume.social_links.linkedin,
      selectors: ['input[name*="linkedin" i]', 'input[id*="linkedin" i]'],
    },
    {
      field: "github",
      value: resume.social_links.github,
      selectors: ['input[name*="github" i]', 'input[id*="github" i]'],
    },
    {
      field: "portfolio",
      value: resume.social_links.portfolio,
      selectors: [
        'input[name*="portfolio" i]',
        'input[name*="website" i]',
        'input[id*="portfolio" i]',
      ],
    },
  ];

  if (extra.coverLetterText) {
    targets.push({
      field: "cover_letter",
      value: extra.coverLetterText,
      selectors: [
        'textarea[name*="cover" i]',
        'textarea[id*="cover" i]',
        'textarea[placeholder*="cover letter" i]',
      ],
    });
  }

  return targets.filter((t) => t.value && t.value.trim().length > 0);
}

/**
 * File-upload targets (resume PDF). Handled separately from text fields
 * since Playwright uses setInputFiles, not fill().
 */
export function buildFileFieldTargets(resumePdfUrl: string | null | undefined) {
  if (!resumePdfUrl) return [];
  return [
    {
      field: "resume_upload",
      url: resumePdfUrl,
      selectors: [
        'input[type="file"][name*="resume" i]',
        'input[type="file"][id*="resume" i]',
        'input[type="file"]',
      ],
    },
  ];
}
