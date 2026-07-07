export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

// ── Enum 타입 ──────────────────────────────────────────────────────────────

export type GenderType = "남성" | "여성";
export type NationalityType = "내국인" | "외국인";
export type MaritalStatusType = "미혼" | "기혼";
export type ParentCohabitationType = "동거" | "별거";
export type AdmissionType = "일반입학" | "편입학" | "재입학";
export type MilitaryStatusType = "군필" | "미필" | "비대상" | "면제";
export type SchoolLocationType = "국내 대학" | "해외 대학";
export type SchoolCategoryType = "4년제" | "전문대" | "대학원" | "사이버대" | "방통대";
export type EnrollmentStatusType =
  | "신입생" | "재학" | "휴학" | "초과이수기" | "수료" | "졸업예정" | "졸업";
export type SpecialInfoType =
  | "다문화가정" | "기초생활수급자" | "차상위계층" | "장애인(본인)" | "장애인(가정)"
  | "농어촌자녀" | "보훈대상자" | "조부모가정" | "다자녀" | "한부모가정"
  | "학생가장" | "북한이탈주민" | "자립준비청년" | "독립유공자후손" | "공상자" | "산재근로자 가정"
  | "순직자유자녀";
export type ParentOccupationType =
  | "직업군인" | "군무원" | "농축어업인" | "건설근로자" | "소상공인"
  | "경찰/소방관" | "택배기사" | "환경미화원" | "연극인";
export type InstitutionType =
  | "국가기관" | "지방자치단체" | "공공기관" | "기업" | "재단법인"
  | "학교법인" | "언론/방송" | "종교단체" | "기타";
export type SupportCategory =
  | "등록금" | "생활비" | "학업장려금" | "연구비" | "해외연수비" | "기타";
/** 장학금 분류: 교내(on_campus) / 교외(off_campus) */
export type ScholarshipType = "on_campus" | "off_campus";
export type UserRoleType = "user" | "admin";
export type OrganizationKindType = "학과" | "학교" | "재단" | "기타";
export type OrgRequestStatusType = "pending" | "approved" | "rejected";
/** org_units 노드 유형 (표시/필터용, 부모-자식 전이 강제 없음) */
export type OrgUnitType = "university" | "college" | "division" | "department";
export type CrawlerSourceLevel = "university" | "college" | "division" | "department";
export type CrawlerNoticeReviewStatus = "new" | "promoted" | "rejected" | "ignored";
export type CrawlerRunMode = "daily" | "baseline" | "audit" | "manual" | "backfill";
export type CrawlerRunStatus = "running" | "succeeded" | "failed" | "partial" | "cancelled";
export type CrawlerAssetKind = "image" | "attachment";
export type CrawlerAssetStatus = "referenced" | "stored" | "extracted" | "failed" | "ignored";

// ── Database 타입 ─────────────────────────────────────────────────────────

export interface Database {
  public: {
    Tables: {
      // ── 대학교 / 단과대 / 학과 참조 테이블 ─────────────────────────────
      universities: {
        Row: { id: number; name: string; created_at: string };
        Insert: { name: string; created_at?: string };
        Update: Partial<Database["public"]["Tables"]["universities"]["Insert"]>;
        Relationships: [];
      };
      university_colleges: {
        Row: { id: number; university_id: number; name: string; created_at: string };
        Insert: { university_id: number; name: string; created_at?: string };
        Update: Partial<Database["public"]["Tables"]["university_colleges"]["Insert"]>;
        Relationships: [];
      };
      university_departments: {
        Row: { id: number; college_id: number; name: string; created_at: string };
        Insert: { college_id: number; name: string; created_at?: string };
        Update: Partial<Database["public"]["Tables"]["university_departments"]["Insert"]>;
        Relationships: [];
      };

      // ── org_unit 트리 (대학-단과대-(학부)-학과 통합, 기존 3개 테이블 대체 예정) ──
      org_units: {
        Row: {
          id: number;
          parent_id: number | null;
          unit_type: OrgUnitType;
          name: string;
          /** 루트(대학)부터 자기 자신까지의 조상 id 배열 (트리거 자동 유지) */
          path_ids: number[];
          /** 교외 장학금 계열 매칭 코드 (예: 공학) — 학과 노드에 부여 */
          field_code: string | null;
          legacy_table: string | null;
          legacy_id: number | null;
          created_at: string;
        };
        Insert: {
          parent_id?: number | null;
          unit_type: OrgUnitType;
          name: string;
          field_code?: string | null;
          legacy_table?: string | null;
          legacy_id?: number | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["org_units"]["Insert"]>;
        Relationships: [];
      };

      org_unit_aliases: {
        Row: { id: number; org_unit_id: number; alias: string; created_at: string };
        Insert: { org_unit_id: number; alias: string; created_at?: string };
        Update: Partial<Database["public"]["Tables"]["org_unit_aliases"]["Insert"]>;
        Relationships: [];
      };

      /** 교내 장학금의 org_unit 타겟 (노드 + 하위 전체 매칭) */
      scholarship_target_units: {
        Row: { scholarship_id: number; org_unit_id: number; created_at: string };
        Insert: { scholarship_id: number; org_unit_id: number; created_at?: string };
        Update: Partial<Database["public"]["Tables"]["scholarship_target_units"]["Insert"]>;
        Relationships: [];
      };

      // ── 프로필 ───────────────────────────────────────────────────────────
      profiles: {
        Row: {
          id: string;
          email: string;
          role: UserRoleType;
          is_onboarded: boolean;
          is_org_manager: boolean;
          org_affiliation_kind: OrganizationKindType | null;
          org_affiliation_name: string | null;
          org_approved_at: string | null;
          // 인적사항
          name: string | null;
          birth_date: string | null;
          gender: GenderType | null;
          phone: string | null;
          address: string | null;
          nationality: NationalityType | null;
          marital_status: MaritalStatusType | null;
          parent_cohabitation: ParentCohabitationType | null;
          parent_address: string | null;
          // 학적사항
          school_location: SchoolLocationType | null;
          school_category: SchoolCategoryType | null;
          admission_type: AdmissionType | null;
          school_name: string | null;
          department: string | null;
          university_id: number | null;
          college_id: number | null;
          department_id: number | null;
          has_double_major: boolean;
          double_major_college_id: number | null;
          double_major_department_id: number | null;
          double_major_department: string | null;
          /** 소속 org_unit (가장 구체적으로 확정된 노드). 학과 미정이면 단과대 노드 가능 */
          org_unit_id: number | null;
          double_major_org_unit_id: number | null;
          academic_year: number | null;
          academic_semester: number | null;
          enrollment_status: EnrollmentStatusType | null;
          gpa: number | null;              // 전체 누적 학점
          gpa_last_semester: number | null; // 직전 학기 학점
          last_semester_earned_credits: number | null; // 직전 학기 이수학점
          // 재정/가계
          income_level: number | null;
          household_size: number | null;
          // 기타/특수
          special_info: SpecialInfoType[] | null;
          parent_occupation: ParentOccupationType[] | null;
          military_status: MilitaryStatusType | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          email: string;
          role?: UserRoleType;
          is_onboarded?: boolean;
          is_org_manager?: boolean;
          org_affiliation_kind?: OrganizationKindType | null;
          org_affiliation_name?: string | null;
          org_approved_at?: string | null;
          name?: string | null;
          birth_date?: string | null;
          gender?: GenderType | null;
          phone?: string | null;
          address?: string | null;
          nationality?: NationalityType | null;
          marital_status?: MaritalStatusType | null;
          parent_cohabitation?: ParentCohabitationType | null;
          parent_address?: string | null;
          school_location?: SchoolLocationType | null;
          school_category?: SchoolCategoryType | null;
          admission_type?: AdmissionType | null;
          school_name?: string | null;
          department?: string | null;
          university_id?: number | null;
          college_id?: number | null;
          department_id?: number | null;
          has_double_major?: boolean;
          double_major_college_id?: number | null;
          double_major_department_id?: number | null;
          double_major_department?: string | null;
          org_unit_id?: number | null;
          double_major_org_unit_id?: number | null;
          academic_year?: number | null;
          academic_semester?: number | null;
          enrollment_status?: EnrollmentStatusType | null;
          gpa?: number | null;
          gpa_last_semester?: number | null;
          last_semester_earned_credits?: number | null;
          income_level?: number | null;
          household_size?: number | null;
          special_info?: SpecialInfoType[] | null;
          parent_occupation?: ParentOccupationType[] | null;
          military_status?: MilitaryStatusType | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["profiles"]["Insert"]>;
        Relationships: [];
      };

      // ── 북마크 ───────────────────────────────────────────────────────────
      bookmarks: {
        Row: {
          id: number;
          user_id: string;
          scholarship_id: number;
          created_at: string;
        };
        Insert: {
          user_id: string;
          scholarship_id: number;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["bookmarks"]["Insert"]>;
        Relationships: [];
      };

      org_signup_requests: {
        Row: {
          id: number;
          user_id: string | null;
          email: string;
          applicant_name: string;
          organization_kind: OrganizationKindType;
          organization_name: string;
          status: OrgRequestStatusType;
          request_note: string | null;
          requested_at: string;
          reviewed_at: string | null;
          reviewed_by: string | null;
          review_note: string | null;
          created_at: string;
        };
        Insert: {
          id?: number;
          user_id?: string | null;
          email: string;
          applicant_name: string;
          organization_kind: OrganizationKindType;
          organization_name: string;
          status?: OrgRequestStatusType;
          request_note?: string | null;
          requested_at?: string;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          review_note?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["org_signup_requests"]["Insert"]>;
        Relationships: [];
      };

      crawled_notices: {
        Row: {
          id: number;
          source_group: string;
          source_id: string;
          source_name: string;
          title: string;
          notice_url: string;
          notice_posted_at: string | null;
          raw_date_text: string | null;
          body: string | null;
          scholarship_type: ScholarshipType;
          status: "new" | "promoted" | "rejected";
          scholarship_id: number | null;
          /** LLM이 추출한 scholarship 필드 초안 (검수 전) */
          extracted_draft: Record<string, unknown> | null;
          reviewed_at: string | null;
          reviewed_by: string | null;
          review_note: string | null;
          run_at: string | null;
          first_seen_at: string;
          last_seen_at: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: number;
          source_group?: string;
          source_id?: string;
          source_name?: string;
          title: string;
          notice_url: string;
          notice_posted_at?: string | null;
          raw_date_text?: string | null;
          body?: string | null;
          scholarship_type?: ScholarshipType;
          status?: "new" | "promoted" | "rejected";
          scholarship_id?: number | null;
          extracted_draft?: Record<string, unknown> | null;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          review_note?: string | null;
          run_at?: string | null;
          first_seen_at?: string;
          last_seen_at?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["crawled_notices"]["Insert"]>;
        Relationships: [];
      };

      crawler_notice_sources: {
        Row: {
          id: number;
          source_key: string;
          university_slug: string | null;
          source_level: CrawlerSourceLevel;
          source_name: string;
          configured_url: string;
          effective_url: string | null;
          base_url: string | null;
          parser_config: Json;
          adapter_code: string | null;
          enabled: boolean;
          health: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: number;
          source_key: string;
          university_slug?: string | null;
          source_level?: CrawlerSourceLevel;
          source_name: string;
          configured_url: string;
          effective_url?: string | null;
          base_url?: string | null;
          parser_config?: Json;
          adapter_code?: string | null;
          enabled?: boolean;
          health?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["crawler_notice_sources"]["Insert"]>;
        Relationships: [];
      };

      crawler_source_targets: {
        Row: {
          source_id: number;
          org_unit_id: number;
          priority: number;
          created_at: string;
        };
        Insert: {
          source_id: number;
          org_unit_id: number;
          priority?: number;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["crawler_source_targets"]["Insert"]>;
        Relationships: [];
      };

      crawler_notices: {
        Row: {
          id: number;
          canonical_key: string;
          canonical_url: string | null;
          native_post_id: string | null;
          title: string;
          body_text: string | null;
          body_html: string | null;
          posted_at: string | null;
          content_hash: string | null;
          review_status: CrawlerNoticeReviewStatus;
          scholarship_id: number | null;
          first_seen_at: string;
          last_seen_at: string;
          deleted_at: string | null;
          metadata: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: number;
          canonical_key: string;
          canonical_url?: string | null;
          native_post_id?: string | null;
          title: string;
          body_text?: string | null;
          body_html?: string | null;
          posted_at?: string | null;
          content_hash?: string | null;
          review_status?: CrawlerNoticeReviewStatus;
          scholarship_id?: number | null;
          first_seen_at?: string;
          last_seen_at?: string;
          deleted_at?: string | null;
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["crawler_notices"]["Insert"]>;
        Relationships: [];
      };

      crawler_notice_url_aliases: {
        Row: {
          id: number;
          notice_id: number;
          source_id: number | null;
          url: string;
          url_hash: string;
          first_seen_at: string;
          last_seen_at: string;
          created_at: string;
        };
        Insert: {
          id?: number;
          notice_id: number;
          source_id?: number | null;
          url: string;
          first_seen_at?: string;
          last_seen_at?: string;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["crawler_notice_url_aliases"]["Insert"]>;
        Relationships: [];
      };

      crawler_runs: {
        Row: {
          id: string;
          started_at: string;
          ended_at: string | null;
          mode: CrawlerRunMode;
          git_sha: string | null;
          config_hash: string | null;
          parser_version: string | null;
          status: CrawlerRunStatus;
          totals: Json;
          metadata: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          started_at?: string;
          ended_at?: string | null;
          mode: CrawlerRunMode;
          git_sha?: string | null;
          config_hash?: string | null;
          parser_version?: string | null;
          status?: CrawlerRunStatus;
          totals?: Json;
          metadata?: Json;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["crawler_runs"]["Insert"]>;
        Relationships: [];
      };

      crawler_notice_occurrences: {
        Row: {
          id: number;
          notice_id: number;
          source_id: number;
          crawl_run_id: string | null;
          discovered_url: string;
          discovered_url_hash: string;
          final_url: string | null;
          native_post_id: string | null;
          list_title: string | null;
          raw_list_text: string | null;
          list_posted_at: string | null;
          detail_fetched_at: string | null;
          content_hash: string | null;
          first_seen_at: string;
          last_seen_at: string;
          deleted_at: string | null;
          metadata: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: number;
          notice_id: number;
          source_id: number;
          crawl_run_id?: string | null;
          discovered_url: string;
          final_url?: string | null;
          native_post_id?: string | null;
          list_title?: string | null;
          raw_list_text?: string | null;
          list_posted_at?: string | null;
          detail_fetched_at?: string | null;
          content_hash?: string | null;
          first_seen_at?: string;
          last_seen_at?: string;
          deleted_at?: string | null;
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["crawler_notice_occurrences"]["Insert"]>;
        Relationships: [];
      };

      crawler_notice_targets: {
        Row: {
          notice_id: number;
          org_unit_id: number;
          source_id: number | null;
          confidence: number;
          evidence: Json;
          created_at: string;
        };
        Insert: {
          notice_id: number;
          org_unit_id: number;
          source_id?: number | null;
          confidence?: number;
          evidence?: Json;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["crawler_notice_targets"]["Insert"]>;
        Relationships: [];
      };

      crawler_notice_assets: {
        Row: {
          id: number;
          notice_id: number;
          occurrence_id: number | null;
          asset_kind: CrawlerAssetKind;
          source_url: string;
          source_url_hash: string;
          storage_bucket: string | null;
          storage_key: string | null;
          filename: string | null;
          mime: string | null;
          sha256: string | null;
          width: number | null;
          height: number | null;
          position: number | null;
          alt: string | null;
          caption: string | null;
          extracted_text: string | null;
          status: CrawlerAssetStatus;
          metadata: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: number;
          notice_id: number;
          occurrence_id?: number | null;
          asset_kind: CrawlerAssetKind;
          source_url: string;
          storage_bucket?: string | null;
          storage_key?: string | null;
          filename?: string | null;
          mime?: string | null;
          sha256?: string | null;
          width?: number | null;
          height?: number | null;
          position?: number | null;
          alt?: string | null;
          caption?: string | null;
          extracted_text?: string | null;
          status?: CrawlerAssetStatus;
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["crawler_notice_assets"]["Insert"]>;
        Relationships: [];
      };

      crawler_keyword_matches: {
        Row: {
          id: number;
          notice_id: number;
          rule_version: string;
          keyword: string;
          field: string;
          offset_start: number | null;
          offset_end: number | null;
          score: number | null;
          created_at: string;
        };
        Insert: {
          id?: number;
          notice_id: number;
          rule_version: string;
          keyword: string;
          field: string;
          offset_start?: number | null;
          offset_end?: number | null;
          score?: number | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["crawler_keyword_matches"]["Insert"]>;
        Relationships: [];
      };

      crawler_source_results: {
        Row: {
          run_id: string;
          source_id: number;
          decision: string;
          counts: Json;
          strategy_code: string | null;
          adapter_code: string | null;
          elapsed_ms: number | null;
          error_count: number;
          primary_failure_code: string | null;
          metadata: Json;
          created_at: string;
        };
        Insert: {
          run_id: string;
          source_id: number;
          decision: string;
          counts?: Json;
          strategy_code?: string | null;
          adapter_code?: string | null;
          elapsed_ms?: number | null;
          error_count?: number;
          primary_failure_code?: string | null;
          metadata?: Json;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["crawler_source_results"]["Insert"]>;
        Relationships: [];
      };

      crawler_audit_results: {
        Row: {
          id: number;
          run_id: string | null;
          source_id: number;
          decision: string;
          failure_code: string | null;
          access_profile: Json;
          sample: Json;
          evidence: Json;
          created_at: string;
        };
        Insert: {
          id?: number;
          run_id?: string | null;
          source_id: number;
          decision: string;
          failure_code?: string | null;
          access_profile?: Json;
          sample?: Json;
          evidence?: Json;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["crawler_audit_results"]["Insert"]>;
        Relationships: [];
      };

      crawler_errors: {
        Row: {
          id: number;
          run_id: string | null;
          source_id: number | null;
          notice_id: number | null;
          occurrence_id: number | null;
          stage: string;
          error_class: string | null;
          http_status: number | null;
          retry_count: number;
          message: string;
          details: Json;
          created_at: string;
        };
        Insert: {
          id?: number;
          run_id?: string | null;
          source_id?: number | null;
          notice_id?: number | null;
          occurrence_id?: number | null;
          stage: string;
          error_class?: string | null;
          http_status?: number | null;
          retry_count?: number;
          message: string;
          details?: Json;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["crawler_errors"]["Insert"]>;
        Relationships: [];
      };

      analytics_events: {
        Row: {
          id: number;
          occurred_at: string;
          event_name: string;
          user_id: string | null;
          session_id: string | null;
          page_path: string | null;
          scholarship_id: number | null;
          search_query: string | null;
          sort_key: string | null;
          scope_filter: string | null;
          metadata: Json;
          created_at: string;
        };
        Insert: {
          occurred_at?: string;
          event_name: string;
          user_id?: string | null;
          session_id?: string | null;
          page_path?: string | null;
          scholarship_id?: number | null;
          search_query?: string | null;
          sort_key?: string | null;
          scope_filter?: string | null;
          metadata?: Json;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["analytics_events"]["Insert"]>;
        Relationships: [];
      };

      analytics_daily_kpi: {
        Row: {
          metric_date: string;
          page_view_count: number;
          unique_user_count: number;
          search_count: number;
          bookmark_toggle_count: number;
          scholarship_open_count: number;
          apply_click_count: number;
          updated_at: string;
        };
        Insert: {
          metric_date: string;
          page_view_count?: number;
          unique_user_count?: number;
          search_count?: number;
          bookmark_toggle_count?: number;
          scholarship_open_count?: number;
          apply_click_count?: number;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["analytics_daily_kpi"]["Insert"]>;
        Relationships: [];
      };

      analytics_scholarship_daily_kpi: {
        Row: {
          metric_date: string;
          scholarship_id: number;
          detail_view_count: number;
          bookmark_toggle_count: number;
          apply_click_count: number;
          unique_user_count: number;
          updated_at: string;
        };
        Insert: {
          metric_date: string;
          scholarship_id: number;
          detail_view_count?: number;
          bookmark_toggle_count?: number;
          apply_click_count?: number;
          unique_user_count?: number;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["analytics_scholarship_daily_kpi"]["Insert"]>;
        Relationships: [];
      };

      analytics_search_term_daily: {
        Row: {
          metric_date: string;
          search_query: string;
          search_count: number;
          updated_at: string;
        };
        Insert: {
          metric_date: string;
          search_query: string;
          search_count?: number;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["analytics_search_term_daily"]["Insert"]>;
        Relationships: [];
      };

      analytics_retention_daily: {
        Row: {
          cohort_date: string;
          cohort_size: number;
          d1_return_users: number;
          d3_return_users: number;
          d7_return_users: number;
          d1_retention_rate: number;
          d3_retention_rate: number;
          d7_retention_rate: number;
          updated_at: string;
        };
        Insert: {
          cohort_date: string;
          cohort_size?: number;
          d1_return_users?: number;
          d3_return_users?: number;
          d7_return_users?: number;
          d1_retention_rate?: number;
          d3_retention_rate?: number;
          d7_retention_rate?: number;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["analytics_retention_daily"]["Insert"]>;
        Relationships: [];
      };

      /** 공개 사이트 설정 (헤더 로고 URL 등). 단일 행 id=1 */
      site_settings: {
        Row: {
          id: number;
          header_logo_url: string | null;
          updated_at: string;
        };
        Insert: {
          id?: number;
          header_logo_url?: string | null;
          updated_at?: string;
        };
        Update: {
          header_logo_url?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };

      // ── 장학금 ───────────────────────────────────────────────────────────
      scholarships: {
        Row: {
          id: number;
          name: string;
          organization: string;
          scholarship_type: ScholarshipType;
          institution_type: InstitutionType;
          support_types: SupportCategory[];
          support_amount_text: string | null;
          view_count: number;
          apply_start_date: string;
          apply_end_date: string;
          announcement_date: string | null;
          selection_count: number | null;
          qual_university: string[] | null;       // 특정 대학교명 배열
          qual_school_location: SchoolLocationType[] | null;
          qual_school_category: SchoolCategoryType[] | null;
          qual_academic_year: number[] | null;
          qual_enrollment_status: EnrollmentStatusType[] | null;
          qual_major: string[] | null;             // 전공/학과명 배열 (텍스트 매칭, 이행기 폴백)
          /** 교외 장학금 계열 타겟 (org_units.field_code와 매칭). NULL/빈 배열 = 제한 없음 */
          qual_field_codes: string[] | null;
          qual_gpa_min: number | null;               // 누적 학점 최소
          qual_gpa_last_semester_min: number | null; // 직전 학기 학점 최소
          qual_last_semester_earned_credits_min: number | null; // 직전 학기 이수학점 최소
          qual_income_level_min: number | null;
          qual_income_level_max: number | null;
          qual_household_size_max: number | null;
          qual_gender: GenderType | null;
          qual_age_min: number | null;
          qual_age_max: number | null;
          qual_region: string[] | null;
          qual_nationality: NationalityType | null;
          qual_admission_type: AdmissionType[] | null;
          qual_parent_cohabitation: ParentCohabitationType | null;
          qual_parent_region: string[] | null;
          /** 상세 지원자격 기타 요건 표시용 자유 텍스트 배열 */
          qual_special_info: string[] | null;
          /** 상세 지원자격에 표시되는 자유 텍스트(매칭 미사용) */
          qual_extra_requirements: string[] | null;
          qual_parent_occupation: ParentOccupationType[] | null;
          qual_military_status: MilitaryStatusType | null;
          can_overlap: boolean;
          required_documents: string[];
          apply_method: string;
          apply_url: string;
          homepage_url: string | null;
          contact: string | null;
          note: string | null;
          selection_stages: number;
          selection_stage_1: string;
          selection_stage_2: string | null;
          selection_stage_3: string | null;
          selection_stage_4: string | null;
          selection_stage_5: string | null;
          selection_note: string | null;
          selection_stage_1_schedule: string | null;
          selection_stage_2_schedule: string | null;
          selection_stage_3_schedule: string | null;
          selection_stage_4_schedule: string | null;
          selection_stage_5_schedule: string | null;
          poster_image_url: string | null; // 공지 포스터 이미지 URL
          original_notice_image_url: string | null;
          original_notice_image_urls: string[] | null;
          original_notice_text: string | null;
          collected_at: string;
          is_verified: boolean;
          /** false면 홈 전체 목록 숨김, 맞춤 장학금(RPC)에서만 노출 */
          list_on_home: boolean;
          /** 장학금이 아닌 광고/채용 공고 카드로 표시 */
          is_advertisement: boolean;
          /** 광고(채용) 공고용 모집 직무 */
          ad_job_role: string | null;
          /** 광고(채용) 공고용 요구 역량 */
          ad_required_skills: string[] | null;
          /** 광고(채용) 공고용 소재지 */
          ad_location: string | null;
          /** 홈 전체 장학금 목록에서 상단(추천) 노출 */
          is_recommended: boolean;
          /** 추천 항목끼리 정렬: 작을수록 앞; null은 추천 그룹 내 맨 뒤 */
          recommended_sort_order: number | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<
          Database["public"]["Tables"]["scholarships"]["Row"],
          "id" | "created_at" | "updated_at" | "poster_image_url" | "view_count" | "qual_field_codes"
        > & Partial<Pick<Database["public"]["Tables"]["scholarships"]["Row"], "created_at" | "updated_at" | "poster_image_url" | "view_count" | "qual_field_codes">>;
        Update: Partial<Database["public"]["Tables"]["scholarships"]["Insert"]>;
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      get_matched_scholarships: {
        Args: { p_user_id: string };
        Returns: Database["public"]["Tables"]["scholarships"]["Row"][];
      };
      get_scholarship_scrap_counts: {
        Args: { p_scholarship_ids: number[] };
        Returns: { scholarship_id: number; scrap_count: number }[];
      };
      increment_scholarship_view_count: {
        Args: { p_scholarship_id: number };
        Returns: number;
      };
      get_public_home_scholarships_page: {
        Args: { p_page: number; p_page_size: number };
        Returns: Json;
      };
      track_analytics_event: {
        Args: {
          p_event_name: string;
          p_page_path?: string | null;
          p_scholarship_id?: number | null;
          p_search_query?: string | null;
          p_sort_key?: string | null;
          p_scope_filter?: string | null;
          p_metadata?: Json | null;
        };
        Returns: undefined;
      };
      refresh_analytics_daily: {
        Args: { p_target_date?: string };
        Returns: undefined;
      };
      get_urgent_bookmark_count: {
        Args: { p_user_id: string; p_deadline_days?: number };
        Returns: number;
      };
      is_admin: {
        Args: Record<string, never>;
        Returns: boolean;
      };
      grant_admin: {
        Args: { target_user_id: string };
        Returns: undefined;
      };
      revoke_admin: {
        Args: { target_user_id: string };
        Returns: undefined;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
}

// ── 편의 타입 ─────────────────────────────────────────────────────────────

export type Profile = Database["public"]["Tables"]["profiles"]["Row"];
export type ProfileUpdate = Database["public"]["Tables"]["profiles"]["Update"];
export type Scholarship = Database["public"]["Tables"]["scholarships"]["Row"];
export type University = Database["public"]["Tables"]["universities"]["Row"];
export type UniversityCollege = Database["public"]["Tables"]["university_colleges"]["Row"];
export type UniversityDepartment = Database["public"]["Tables"]["university_departments"]["Row"];
export type OrgUnit = Database["public"]["Tables"]["org_units"]["Row"];
export type OrgUnitAlias = Database["public"]["Tables"]["org_unit_aliases"]["Row"];
export type ScholarshipTargetUnit = Database["public"]["Tables"]["scholarship_target_units"]["Row"];
export type CrawlerNoticeSource = Database["public"]["Tables"]["crawler_notice_sources"]["Row"];
export type CrawlerSourceTarget = Database["public"]["Tables"]["crawler_source_targets"]["Row"];
export type CrawlerNotice = Database["public"]["Tables"]["crawler_notices"]["Row"];
export type CrawlerNoticeUrlAlias = Database["public"]["Tables"]["crawler_notice_url_aliases"]["Row"];
export type CrawlerNoticeOccurrence = Database["public"]["Tables"]["crawler_notice_occurrences"]["Row"];
export type CrawlerNoticeTarget = Database["public"]["Tables"]["crawler_notice_targets"]["Row"];
export type CrawlerNoticeAsset = Database["public"]["Tables"]["crawler_notice_assets"]["Row"];
export type CrawlerKeywordMatch = Database["public"]["Tables"]["crawler_keyword_matches"]["Row"];
export type CrawlerRun = Database["public"]["Tables"]["crawler_runs"]["Row"];
export type CrawlerSourceResult = Database["public"]["Tables"]["crawler_source_results"]["Row"];
export type CrawlerAuditResult = Database["public"]["Tables"]["crawler_audit_results"]["Row"];
export type CrawlerError = Database["public"]["Tables"]["crawler_errors"]["Row"];
