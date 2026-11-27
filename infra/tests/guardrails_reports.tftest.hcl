# Plan-only guardrail tests against mocked providers: no AWS credentials, no
# state, no sops key (the runtime secrets are ephemeral variables, set to
# synthetic values below). They pin the production guardrails that
# `terraform validate` can't see. This file: the report bucket, renderer and render queues, report downloads through
# CloudFront signed URLs, and issued evidence packs' PDFs.
#
# The guardrails are split across the tests/guardrails_*.tftest.hcl files so
# bin/check-infra.sh runs them in parallel (one file's run blocks run one by
# one). Each file carries the same mocked providers, overrides and variables,
# copied, since a test file can't share them: keep every copy identical
# (infra/scripts/guardrails-preamble.test.mjs checks).
#
#   pnpm check:infra          (bin/check-infra.sh: fmt + validate + test)
#
# CI runs the same thing (.github/workflows/ci.yml, job `terraform`).


mock_provider "aws" {
  # A mocked policy document renders a random string, which IAM/SNS/S3 policy
  # arguments then reject as invalid JSON. Any well-formed document does.
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
  mock_data "aws_availability_zones" {
    defaults = {
      names    = ["af-south-1a", "af-south-1b", "af-south-1c"]
      zone_ids = ["afs1-az1", "afs1-az2", "afs1-az3"]
    }
  }
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "000000000000"
    }
  }
  mock_data "aws_iam_role" {
    defaults = {
      arn  = "arn:aws:iam::000000000000:role/water-management-deploy"
      name = "water-management-deploy"
      # The bootstrap's trust policy as IAM returns it (single values
      # collapsed to strings) — templates infra/modules/project-baseline.
      assume_role_policy = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Federated\":\"arn:aws:iam::000000000000:oidc-provider/token.actions.githubusercontent.com\"},\"Action\":\"sts:AssumeRoleWithWebIdentity\",\"Condition\":{\"StringEquals\":{\"token.actions.githubusercontent.com:aud\":\"sts.amazonaws.com\",\"token.actions.githubusercontent.com:sub\":\"repo:Absence0760/project-water-management:environment:production\"}}}]}"
    }
  }
}

mock_provider "aws" {
  alias = "us_east_1"
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

mock_provider "archive" {}
mock_provider "random" {}

# Mocked RDS has no provider logic, so the computed master secret and
# endpoint would stay unknown/empty. Supply what RDS really returns.
override_resource {
  target          = aws_db_instance.main
  override_during = plan
  values = {
    address = "water-management.abc123.af-south-1.rds.amazonaws.com"
    port    = 5432
    master_user_secret = [{
      secret_arn    = "arn:aws:secretsmanager:af-south-1:000000000000:secret:rds!db-00000000-0000-0000-0000-000000000000-AbCdEf"
      kms_key_id    = "arn:aws:kms:af-south-1:000000000000:key/00000000-0000-0000-0000-000000000000"
      secret_status = "active"
    }]
  }
}

override_resource {
  target          = aws_acm_certificate.frontend
  override_during = plan
  values = {
    arn = "arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000"
    domain_validation_options = [{
      domain_name           = "icwbt.jaredhoward.com"
      resource_record_name  = "_0123abcd.icwbt.jaredhoward.com."
      resource_record_type  = "CNAME"
      resource_record_value = "_4567efab.acm-validations.aws."
      }, {
      domain_name           = "water-management.jaredhoward.com"
      resource_record_name  = "_89abcdef.water-management.jaredhoward.com."
      resource_record_type  = "CNAME"
      resource_record_value = "_0123cdef.acm-validations.aws."
    }]
  }
}

# Easy DKIM returns three tokens only after create; the DKIM records index them.
override_resource {
  target          = aws_sesv2_email_identity.domain
  override_during = plan
  values = {
    arn = "arn:aws:ses:af-south-1:000000000000:identity/icwbt.jaredhoward.com"
    dkim_signing_attributes = {
      next_signing_key_length = "RSA_2048_BIT"
      tokens                  = ["tok1", "tok2", "tok3"]
    }
  }
}

override_resource {
  target          = aws_sesv2_configuration_set.main
  override_during = plan
  values = {
    arn = "arn:aws:ses:af-south-1:000000000000:configuration-set/water-management"
  }
}

# Known ARNs / IDs so wiring (WAF → distribution, header policy → behaviour,
# alarm → topic) can be asserted by equality at plan time.
override_resource {
  target          = aws_wafv2_web_acl.frontend
  override_during = plan
  values = {
    arn = "arn:aws:wafv2:us-east-1:000000000000:global/webacl/water-management-frontend-acl/00000000-0000-0000-0000-000000000000"
  }
}

override_resource {
  target          = aws_cloudfront_response_headers_policy.site
  override_during = plan
  values = {
    id = "site-headers-policy-id"
  }
}

override_resource {
  target          = aws_cloudfront_response_headers_policy.api
  override_during = plan
  values = {
    id = "api-headers-policy-id"
  }
}

override_resource {
  target          = aws_iam_role.lambda
  override_during = plan
  values = {
    id  = "water-management-backend-lambda"
    arn = "arn:aws:iam::000000000000:role/water-management-backend-lambda"
  }
}

override_resource {
  target          = aws_s3_bucket.frontend
  override_during = plan
  values = {
    arn = "arn:aws:s3:::water-management-frontend-000000000000"
  }
}

override_resource {
  target          = aws_cloudfront_distribution.frontend
  override_during = plan
  values = {
    arn = "arn:aws:cloudfront::000000000000:distribution/E0000000000000"
    id  = "E0000000000000"
  }
}

override_resource {
  target          = aws_lambda_function.backend
  override_during = plan
  values = {
    arn = "arn:aws:lambda:af-south-1:000000000000:function:water-management-backend"
  }
}

override_resource {
  target          = aws_lambda_function.migrate
  override_during = plan
  values = {
    arn = "arn:aws:lambda:af-south-1:000000000000:function:water-management-migrate"
  }
}

override_resource {
  target          = aws_lambda_function.worker
  override_during = plan
  values = {
    arn           = "arn:aws:lambda:af-south-1:000000000000:function:water-management-worker"
    function_name = "water-management-worker"
  }
}

override_resource {
  target          = aws_iam_role.worker_lambda
  override_during = plan
  values = {
    id  = "water-management-worker-lambda"
    arn = "arn:aws:iam::000000000000:role/water-management-worker-lambda"
  }
}

override_resource {
  target          = aws_sqs_queue.jobs
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-jobs"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-jobs"
  }
}

override_resource {
  target          = aws_cloudwatch_event_rule.worker_tick
  override_during = plan
  values = {
    arn = "arn:aws:events:af-south-1:000000000000:rule/water-management-worker-tick"
  }
}

override_resource {
  target          = aws_security_group.worker_lambda
  override_during = plan
  values = {
    id = "sg-0000000000worker"
  }
}

# Known IDs for the rest of the security groups and the route table, so the
# network run can assert which group a rule, Lambda or DB points at.
override_resource {
  target          = aws_security_group.api_lambda
  override_during = plan
  values = {
    id = "sg-000000000000api"
  }
}

override_resource {
  target          = aws_security_group.migrate_lambda
  override_during = plan
  values = {
    id = "sg-00000000migrate"
  }
}

override_resource {
  target          = aws_security_group.rds
  override_during = plan
  values = {
    id = "sg-000000000000rds"
  }
}

override_resource {
  target          = aws_security_group.vpce
  override_during = plan
  values = {
    id = "sg-00000000000vpce"
  }
}

override_resource {
  target          = aws_security_group.vpce_sqs
  override_during = plan
  values = {
    id = "sg-000000000vpcesqs"
  }
}

override_resource {
  target          = aws_route_table.private
  override_during = plan
  values = {
    id = "rtb-00000000private"
  }
}

override_resource {
  target          = aws_sqs_queue.jobs_dlq
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-jobs-dlq"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-jobs-dlq"
  }
}

# Data feeds (feeds.tf, WP-2.10)
override_resource {
  target          = aws_sqs_queue.fetch_requests
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-fetch-requests.fifo"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-fetch-requests.fifo"
  }
}

override_resource {
  target          = aws_sqs_queue.fetch_requests_dlq
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-fetch-requests-dlq.fifo"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-fetch-requests-dlq.fifo"
  }
}

override_resource {
  target          = aws_sqs_queue.ingest_results
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-ingest-results"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-ingest-results"
  }
}

override_resource {
  target          = aws_sqs_queue.ingest_results_dlq
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-ingest-results-dlq"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-ingest-results-dlq"
  }
}

override_resource {
  target          = aws_lambda_function.fetcher
  override_during = plan
  values = {
    arn           = "arn:aws:lambda:af-south-1:000000000000:function:water-management-fetcher"
    function_name = "water-management-fetcher"
  }
}

override_resource {
  target          = aws_iam_role.fetcher_lambda
  override_during = plan
  values = {
    id  = "water-management-fetcher-lambda"
    arn = "arn:aws:iam::000000000000:role/water-management-fetcher-lambda"
  }
}

# Server-side reports (reports.tf, WP-2.15 Phase B)
override_resource {
  target          = aws_sqs_queue.render_requests
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-render-requests"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-render-requests"
  }
}

override_resource {
  target          = aws_sqs_queue.render_requests_dlq
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-render-requests-dlq"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-render-requests-dlq"
  }
}

override_resource {
  target          = aws_sqs_queue.render_results
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-render-results"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-render-results"
  }
}

override_resource {
  target          = aws_sqs_queue.render_results_dlq
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-render-results-dlq"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-render-results-dlq"
  }
}

override_resource {
  target          = aws_s3_bucket.reports
  override_during = plan
  values = {
    arn    = "arn:aws:s3:::water-management-reports-000000000000"
    bucket = "water-management-reports-000000000000"
    # The /reports/* origin (s3_cloudfront.tf).
    bucket_regional_domain_name = "water-management-reports-000000000000.s3.af-south-1.amazonaws.com"
  }
}

# Report downloads through CloudFront (reports.tf): known values so the key
# pair, key group, OAC and origin request policy can be matched by equality.
# Placeholder text, not a key: nothing is generated in a test.
# One id per trusted public key (the overlap run uses both), so a key-id
# check can tell them apart.
override_resource {
  target          = aws_cloudfront_public_key.report_downloads["2026-09"]
  override_during = plan
  values = {
    id = "K2026090000000A"
  }
}

override_resource {
  target          = aws_cloudfront_public_key.report_downloads["2027-03"]
  override_during = plan
  values = {
    id = "K2027030000000B"
  }
}

override_resource {
  target          = aws_cloudfront_key_group.report_downloads
  override_during = plan
  values = {
    id = "report-downloads-key-group-id"
  }
}

override_resource {
  target          = aws_cloudfront_origin_access_control.reports
  override_during = plan
  values = {
    id = "reports-oac-id"
  }
}

# Evidence pack PDFs (packs.tf, 119_pack_render)
override_resource {
  target          = aws_s3_bucket.packs
  override_during = plan
  values = {
    arn    = "arn:aws:s3:::water-management-packs-000000000000"
    bucket = "water-management-packs-000000000000"
    # The /packs/* origin (s3_cloudfront.tf).
    bucket_regional_domain_name = "water-management-packs-000000000000.s3.af-south-1.amazonaws.com"
  }
}

override_resource {
  target          = aws_cloudfront_origin_access_control.packs
  override_during = plan
  values = {
    id = "packs-oac-id"
  }
}

# The map's data (map_data.tf, s3_cloudfront.tf's /tiles/*)
override_resource {
  target          = aws_s3_bucket.tiles
  override_during = plan
  values = {
    arn                         = "arn:aws:s3:::water-management-tiles-000000000000"
    bucket                      = "water-management-tiles-000000000000"
    bucket_regional_domain_name = "water-management-tiles-000000000000.s3.af-south-1.amazonaws.com"
  }
}

override_resource {
  target          = aws_cloudfront_origin_access_control.tiles
  override_during = plan
  values = {
    id = "tiles-oac-id"
  }
}

override_resource {
  target          = aws_cloudfront_function.tiles_range
  override_during = plan
  values = {
    arn = "arn:aws:cloudfront::000000000000:function/water-management-tiles-range"
  }
}

override_resource {
  target          = aws_s3_bucket.reference
  override_during = plan
  values = {
    arn    = "arn:aws:s3:::water-management-reference-000000000000"
    bucket = "water-management-reference-000000000000"
  }
}

override_resource {
  target          = aws_s3_bucket.mirror
  override_during = plan
  values = {
    arn    = "arn:aws:s3:::water-management-mirror-000000000000"
    bucket = "water-management-mirror-000000000000"
  }
}

override_resource {
  target          = aws_cloudfront_origin_request_policy.report_downloads
  override_during = plan
  values = {
    id = "report-downloads-origin-request-policy-id"
  }
}

override_resource {
  target          = aws_ecr_repository.ingest
  override_during = plan
  values = {
    arn            = "arn:aws:ecr:af-south-1:000000000000:repository/water-management-mirror-ingest"
    repository_url = "000000000000.dkr.ecr.af-south-1.amazonaws.com/water-management-mirror-ingest"
  }
}

override_resource {
  target          = aws_ecr_repository.renderer
  override_during = plan
  values = {
    arn            = "arn:aws:ecr:af-south-1:000000000000:repository/water-management-renderer"
    repository_url = "000000000000.dkr.ecr.af-south-1.amazonaws.com/water-management-renderer"
  }
}

override_resource {
  target          = aws_iam_role.renderer_lambda
  override_during = plan
  values = {
    id  = "water-management-renderer-lambda"
    arn = "arn:aws:iam::000000000000:role/water-management-renderer-lambda"
  }
}

override_resource {
  target          = aws_security_group.vpce_ses
  override_during = plan
  values = {
    id = "sg-00000000000vpceses"
  }
}

override_resource {
  target          = aws_sns_topic.alerts
  override_during = plan
  values = {
    arn = "arn:aws:sns:af-south-1:000000000000:water-management-prod-alerts"
  }
}

override_resource {
  target          = aws_sns_topic.alerts_us_east_1
  override_during = plan
  values = {
    arn = "arn:aws:sns:us-east-1:000000000000:water-management-prod-alerts"
  }
}

override_resource {
  target          = aws_ce_anomaly_monitor.services
  override_during = plan
  values = {
    arn = "arn:aws:ce::000000000000:anomalymonitor/00000000-0000-0000-0000-000000000000"
  }
}

# SES bounces and complaints → the worker (ses.tf, WP-2.13 follow-up)
override_resource {
  target          = aws_sns_topic.ses_events
  override_during = plan
  values = {
    arn = "arn:aws:sns:af-south-1:000000000000:water-management-ses-events"
  }
}

override_resource {
  target          = aws_sqs_queue.mail_events
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-mail-events"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-mail-events"
  }
}

override_resource {
  target          = aws_sqs_queue.mail_events_dlq
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-mail-events-dlq"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-mail-events-dlq"
  }
}

# Runtime secrets (secrets.tf, issue #126): distinct known ARNs, so each
# role's grant and each endpoint statement can be matched to its own secret.
override_resource {
  target          = aws_iam_role.migrate_lambda
  override_during = plan
  values = {
    id  = "water-management-migrate-lambda"
    arn = "arn:aws:iam::000000000000:role/water-management-migrate-lambda"
  }
}

override_resource {
  target          = aws_secretsmanager_secret.runtime["api"]
  override_during = plan
  values = {
    id  = "arn:aws:secretsmanager:af-south-1:000000000000:secret:water-management/runtime/api-AaAaAa"
    arn = "arn:aws:secretsmanager:af-south-1:000000000000:secret:water-management/runtime/api-AaAaAa"
  }
}

override_resource {
  target          = aws_secretsmanager_secret.runtime["worker"]
  override_during = plan
  values = {
    id  = "arn:aws:secretsmanager:af-south-1:000000000000:secret:water-management/runtime/worker-WwWwWw"
    arn = "arn:aws:secretsmanager:af-south-1:000000000000:secret:water-management/runtime/worker-WwWwWw"
  }
}

override_resource {
  target          = aws_secretsmanager_secret.runtime["migrate"]
  override_during = plan
  values = {
    id  = "arn:aws:secretsmanager:af-south-1:000000000000:secret:water-management/runtime/migrate-MmMmMm"
    arn = "arn:aws:secretsmanager:af-south-1:000000000000:secret:water-management/runtime/migrate-MmMmMm"
  }
}

# Distinct version IDs, so matching each Lambda's RUNTIME_SECRET_VERSION to its
# own secret's version can fail.
override_resource {
  target          = aws_secretsmanager_secret_version.runtime["api"]
  override_during = plan
  values = {
    version_id = "aaaaaaaa-0000-0000-0000-000000000001"
  }
}

override_resource {
  target          = aws_secretsmanager_secret_version.runtime["worker"]
  override_during = plan
  values = {
    version_id = "bbbbbbbb-0000-0000-0000-000000000002"
  }
}

override_resource {
  target          = aws_secretsmanager_secret_version.runtime["migrate"]
  override_during = plan
  values = {
    version_id = "cccccccc-0000-0000-0000-000000000003"
  }
}

# A known CloudFront header, for the ephemerality check's positive control.
override_resource {
  target          = random_password.cloudfront_shared_secret
  override_during = plan
  values = {
    result = "synthetic0cloudfront0header0000000000000000000000"
  }
}

variables {
  aws_region      = "af-south-1"
  route53_zone_id = "Z0000000000000000000"
  # The hostname before issue #551, kept as a redirect, in its own zone.
  redirect_domains = { "water-management.jaredhoward.com" = "Z1111111111111111111" }
  github_repo      = "Absence0760/project-water-management"
  # Synthetic runtime secrets (ephemeral variables, secrets.tf).
  auth_jwt_secret     = "0123456789abcdef0123456789abcdef0123456789abcdef"
  db_app_password     = "abcdef0123456789abcdef0123456789abcdef01234567"
  alerts_token_secret = "fedcba9876543210fedcba9876543210fedcba9876543210"
  app_encryption_key  = "0123abcd0123abcd0123abcd0123abcd0123abcd0123abcd0123abcd0123abcd"
  # PEM armour around a placeholder: the shape the variable checks, not a key.
  cloudfront_private_key = "-----BEGIN PRIVATE KEY-----\ntestonlynotakey\n-----END PRIVATE KEY-----"
  # Report downloads (reports.tf): a public key generated for these tests (its
  # private half was never kept). Public keys aren't secret.
  report_download_public_keys = {
    "2026-09" = <<-EOT
      -----BEGIN PUBLIC KEY-----
      MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsaz6UBDgol3d4/RdJsAq
      BpgFgFKJjgs+6dXsDOL946Mw+N2ulW4LT/k6DEkGZuCJkef1Lqi0JtuVyjhcEwq8
      hfWgorTT3zNc9JMudwCkUwaqLoPBwYKFai8AhIICqxjlnUm1dmVZTcENYDLF4/aS
      EYLj2o4Wap+A8s+FVItY8Q8Vs4LpqiGI/ue0crfDTSERns+h08kIlp2Q6FKwXy/6
      t/h8nqn67PlOHRqo9I6WmH1yCNuyTwjbVKQLQGA91hLbCaKAw1zbKpPS1kgq+eWr
      qajzJK9XcdRlxS3aSSBU66/3tYik4WNlmrzIopEDCJDkgdwFkNBdFkPesowLlwt9
      nQIDAQAB
      -----END PUBLIC KEY-----
    EOT
  }
  report_download_signing_key = "2026-09"
  # Required and validated. Not an example.* (or other RFC 2606) address,
  # which the variable refuses: the site's own domain, and a plan-only test
  # never subscribes it.
  budget_alert_email = "ops@icwbt.jaredhoward.com"
  # The fetcher's user-agent contact (feeds.tf); required, no default.
  feeds_contact = "ops@icwbt.jaredhoward.com"
}

# ---------------------------------------------------------------------------
# Server-side reports (reports.tf, WP-2.15 Phase B)
# ---------------------------------------------------------------------------

run "reports" {
  command = plan

  # --- The bucket: private, encrypted, TLS only, 7 days -------------------------------
  assert {
    condition = (
      aws_s3_bucket_public_access_block.reports.block_public_acls &&
      aws_s3_bucket_public_access_block.reports.block_public_policy &&
      aws_s3_bucket_public_access_block.reports.ignore_public_acls &&
      aws_s3_bucket_public_access_block.reports.restrict_public_buckets
    )
    error_message = "The reports bucket must block every kind of public access."
  }
  assert {
    condition     = one([for r in aws_s3_bucket_server_side_encryption_configuration.reports.rule : one(r.apply_server_side_encryption_by_default).sse_algorithm]) == "AES256"
    error_message = "Report PDFs must be encrypted at rest (SSE-S3)."
  }
  assert {
    condition     = one([for r in aws_s3_bucket_ownership_controls.reports.rule : r.object_ownership]) == "BucketOwnerEnforced"
    error_message = "ACLs off: the bucket owner owns every object."
  }
  assert {
    condition = alltrue([for r in aws_s3_bucket_lifecycle_configuration.reports.rule :
      r.status == "Enabled" && one(r.expiration).days == 7 && one(r.filter).prefix == "reports/"
    ])
    error_message = "Every report PDF must expire after 7 days."
  }
  assert {
    condition     = contains([for s in data.aws_iam_policy_document.reports_bucket_policy.statement : s.sid if s.effect == "Deny"], "DenyInsecureTransport")
    error_message = "The reports bucket must refuse plain-HTTP access."
  }

  # --- The render queues ---------------------------------------------------------------
  assert {
    condition     = alltrue([for q in [aws_sqs_queue.render_requests, aws_sqs_queue.render_requests_dlq, aws_sqs_queue.render_results, aws_sqs_queue.render_results_dlq] : q.sqs_managed_sse_enabled])
    error_message = "Every render queue must be encrypted: requests carry a render token."
  }
  assert {
    condition = (
      jsondecode(aws_sqs_queue.render_requests.redrive_policy).deadLetterTargetArn == aws_sqs_queue.render_requests_dlq.arn &&
      jsondecode(aws_sqs_queue.render_results.redrive_policy).deadLetterTargetArn == aws_sqs_queue.render_results_dlq.arn &&
      jsondecode(aws_sqs_queue.render_requests.redrive_policy).maxReceiveCount == 5 &&
      jsondecode(aws_sqs_queue.render_results.redrive_policy).maxReceiveCount == 5 &&
      aws_sqs_queue.render_requests.visibility_timeout_seconds >= 6 * 120 &&
      aws_sqs_queue.render_results.visibility_timeout_seconds >= 6 * aws_lambda_function.worker.timeout
    )
    error_message = "Each render queue dead-letters after 5 receives, with visibility past its consumer's timeout."
  }

  # --- Nothing renders until the first image exists ------------------------------------------
  assert {
    condition     = length(aws_lambda_function.renderer) == 0 && length(aws_lambda_event_source_mapping.renderer_requests) == 0
    error_message = "Without renderer_image_tag the renderer function isn't created (Lambda can't be created before its image exists)."
  }
  assert {
    condition = (
      aws_ecr_repository.renderer.image_tag_mutability == "IMMUTABLE" &&
      one(aws_ecr_repository.renderer.image_scanning_configuration).scan_on_push
    )
    error_message = "The renderer repository: immutable release tags, scanned on push."
  }

  # --- Least privilege -----------------------------------------------------------------------
  assert {
    condition = (
      toset(flatten([for s in data.aws_iam_policy_document.renderer_lambda.statement : s.resources])) == toset([
        aws_sqs_queue.render_requests.arn, aws_sqs_queue.render_results.arn, "${aws_s3_bucket.reports.arn}/reports/*",
      ]) &&
      alltrue([for s in data.aws_iam_policy_document.renderer_lambda.statement : s.sid != "PutReportPdfs" || toset(s.actions) == toset(["s3:PutObject"])]) &&
      alltrue([for s in data.aws_iam_policy_document.renderer_lambda.statement : alltrue([for a in s.actions : !strcontains(a, "*")])])
    )
    error_message = "The renderer may receive render-requests, send render-results and put PDFs: never read, list or delete them, nor anything else."
  }
  assert {
    condition     = aws_iam_role_policy.lambda_logs["renderer"].role == aws_iam_role.renderer_lambda.id && !contains(keys(aws_iam_role_policy.lambda_vpc_eni), "renderer")
    error_message = "The renderer logs to its own log group only, with no VPC ENI policy (iam.tf; run lambda_logs_scoped in iam.tftest.hcl pins the statement)."
  }
  assert {
    condition = (
      length([for s in data.aws_iam_policy_document.reports_bucket_policy.statement : s if s.effect != "Deny"]) == 1 &&
      one([for s in data.aws_iam_policy_document.reports_bucket_policy.statement : s.sid if s.effect != "Deny"]) == "AllowCloudFrontReadReportPdfs"
    )
    error_message = "The bucket policy's only grant is CloudFront's read of PDFs (run report_downloads pins it); the API never reads the bucket, it signs CloudFront URLs."
  }
  assert {
    condition     = toset(flatten([for s in data.aws_iam_policy_document.worker_reports.statement : s.resources])) == toset([aws_sqs_queue.render_requests.arn, aws_sqs_queue.render_results.arn])
    error_message = "The worker's report policy reaches the two render queues only (no bucket access)."
  }
  assert {
    condition = (
      length(data.aws_iam_policy_document.worker_report_erasure.statement) == 1 &&
      toset(data.aws_iam_policy_document.worker_report_erasure.statement[0].actions) == toset(["s3:DeleteObject"]) &&
      toset(data.aws_iam_policy_document.worker_report_erasure.statement[0].resources) == toset(["${aws_s3_bucket.reports.arn}/reports/*"]) &&
      aws_iam_role_policy.worker_report_erasure.role == aws_iam_role.worker_lambda.id &&
      aws_lambda_function.worker.environment[0].variables["REPORTS_BUCKET"] == aws_s3_bucket.reports.bucket
    )
    error_message = "The worker may only delete PDFs under reports/ (a deleted report's, issue #903): no read or list; it knows the bucket (REPORTS_BUCKET)."
  }
  assert {
    condition     = aws_iam_role_policy.worker_ses.role == aws_iam_role.worker_lambda.id && aws_iam_role_policy.worker_ses.name == "ses-send-no-reply"
    error_message = "The worker sends report emails under the same no-reply-only SES policy as the API (lambda_ses, pinned in run email_ses)."
  }
  assert {
    condition     = contains(flatten([for s in data.aws_iam_policy_document.github_deploy.statement : s.resources if s.sid == "LambdaUpdate"]), "arn:aws:lambda:af-south-1:000000000000:function:water-management-renderer")
    error_message = "The deploy role must be able to move the renderer to a release's image."
  }

  # --- Wiring --------------------------------------------------------------------------------
  assert {
    condition = (
      aws_lambda_function.worker.environment[0].variables["REPORT_RENDERER"] == "sqs" &&
      aws_lambda_function.worker.environment[0].variables["RENDER_REQUESTS_QUEUE_URL"] == aws_sqs_queue.render_requests.url &&
      aws_lambda_function.worker.environment[0].variables["MAIL_TRANSPORT"] == "ses" &&
      aws_lambda_function.backend.environment[0].variables["STORAGE"] == "s3" &&
      aws_lambda_function.backend.environment[0].variables["REPORTS_BUCKET"] == aws_s3_bucket.reports.bucket &&
      aws_lambda_function.backend.environment[0].variables["REPORT_DOWNLOADS"] == "cloudfront"
    )
    error_message = "The worker hands renders to the renderer and mails through SES; the API signs downloads as CloudFront URLs."
  }
  assert {
    condition     = aws_lambda_event_source_mapping.worker_render_results.event_source_arn == aws_sqs_queue.render_results.arn && aws_lambda_event_source_mapping.worker_render_results.function_name == aws_lambda_function.worker.arn
    error_message = "render-results triggers the worker."
  }
  assert {
    condition = (
      one([for m in aws_cloudwatch_metric_alarm.render_requests_dlq_depth[0].metric_query : m.metric[0].dimensions["QueueName"] if m.id == "visible"]) == aws_sqs_queue.render_requests_dlq.name &&
      one([for m in aws_cloudwatch_metric_alarm.render_results_dlq_depth[0].metric_query : m.metric[0].dimensions["QueueName"] if m.id == "visible"]) == aws_sqs_queue.render_results_dlq.name &&
      aws_cloudwatch_metric_alarm.render_requests_dlq_depth[0].threshold == 0 &&
      aws_cloudwatch_metric_alarm.render_results_dlq_depth[0].threshold == 0
    )
    error_message = "A new message in either render DLQ must alarm."
  }
}

# ---------------------------------------------------------------------------
# Report downloads through CloudFront (reports.tf, s3_cloudfront.tf; issue
# #126): /reports/* serves the private bucket through its own OAC to signed
# URLs only, behind the WAF, and nothing else can read a PDF.
# ---------------------------------------------------------------------------

run "report_downloads" {
  command = plan

  # --- The behaviour: signed URLs only, uncached, GET/HEAD, https ----------------------
  assert {
    condition     = length([for b in aws_cloudfront_distribution.frontend.ordered_cache_behavior : b if b.path_pattern == "/reports/*"]) == 1
    error_message = "The distribution must have exactly one /reports/* behaviour (report PDF downloads)."
  }
  assert {
    condition = alltrue([for b in aws_cloudfront_distribution.frontend.ordered_cache_behavior : (
      b.target_origin_id == "s3-reports" &&
      b.trusted_key_groups == tolist([aws_cloudfront_key_group.report_downloads.id]) &&
      b.viewer_protocol_policy == "https-only" &&
      toset(b.allowed_methods) == toset(["GET", "HEAD"]) &&
      b.cache_policy_id == "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" &&
      b.origin_request_policy_id == aws_cloudfront_origin_request_policy.report_downloads.id &&
      b.response_headers_policy_id == "api-headers-policy-id"
    ) if b.path_pattern == "/reports/*"])
    error_message = "/reports/* must serve the reports bucket only to CloudFront signed URLs from the download key group, uncached (CachingDisabled), GET/HEAD over https, with the API's security headers."
  }
  # Positive control for the signer check: no other behaviour trusts a key
  # group, only /reports/* reaches the reports origin and only /packs/* the
  # packs origin (run packs pins that behaviour).
  assert {
    condition = alltrue([for b in aws_cloudfront_distribution.frontend.ordered_cache_behavior :
      (b.path_pattern == "/reports/*") == (b.target_origin_id == "s3-reports") &&
      (b.path_pattern == "/packs/*") == (b.target_origin_id == "s3-packs") &&
      contains(["/reports/*", "/packs/*"], b.path_pattern) == (length(coalesce(b.trusted_key_groups, [])) > 0)
    ]) && length(coalesce(aws_cloudfront_distribution.frontend.default_cache_behavior[0].trusted_key_groups, [])) == 0
    error_message = "Only the /reports/* behaviour reaches the reports bucket and only /packs/* the packs bucket, and they alone require signed URLs."
  }
  assert {
    condition     = aws_cloudfront_distribution.frontend.ordered_cache_behavior[0].path_pattern == "/api/*"
    error_message = "/api/* stays the first ordered behaviour (edge_security indexes it)."
  }
  assert {
    condition     = aws_cloudfront_distribution.frontend.web_acl_id == aws_wafv2_web_acl.frontend.arn
    error_message = "Downloads pass the distribution's WAF (the per-IP rate rule covers every path)."
  }

  # --- The origin: the reports bucket through its own OAC ----------------------------------
  assert {
    condition = alltrue([for o in aws_cloudfront_distribution.frontend.origin :
      o.domain_name == aws_s3_bucket.reports.bucket_regional_domain_name && o.origin_access_control_id == aws_cloudfront_origin_access_control.reports.id
    if o.origin_id == "s3-reports"]) && length([for o in aws_cloudfront_distribution.frontend.origin : o if o.origin_id == "s3-reports"]) == 1
    error_message = "The s3-reports origin must be the reports bucket, read through its OAC."
  }
  assert {
    condition = (
      aws_cloudfront_origin_access_control.reports.origin_access_control_origin_type == "s3" &&
      aws_cloudfront_origin_access_control.reports.signing_behavior == "always" &&
      aws_cloudfront_origin_access_control.reports.signing_protocol == "sigv4"
    )
    error_message = "The reports OAC must sign every origin request (sigv4)."
  }
  assert {
    condition = (
      one(aws_cloudfront_origin_request_policy.report_downloads.cookies_config).cookie_behavior == "none" &&
      one(aws_cloudfront_origin_request_policy.report_downloads.headers_config).header_behavior == "none" &&
      one(aws_cloudfront_origin_request_policy.report_downloads.query_strings_config).query_string_behavior == "whitelist" &&
      one(one(aws_cloudfront_origin_request_policy.report_downloads.query_strings_config).query_strings).items == toset(["response-content-disposition"])
    )
    error_message = "Only the download file name (response-content-disposition) may reach the bucket: no cookies, no viewer headers, no other query."
  }

  # --- The bucket policy: this distribution, GetObject on reports/ only ---------------------
  assert {
    condition = alltrue([for s in data.aws_iam_policy_document.reports_bucket_policy.statement : (
      s.effect == null || s.effect == "Allow"
      ) ? (
      s.sid == "AllowCloudFrontReadReportPdfs" &&
      toset(s.actions) == toset(["s3:GetObject"]) &&
      toset(s.resources) == toset(["${aws_s3_bucket.reports.arn}/reports/*"]) &&
      one(s.principals).type == "Service" &&
      one(s.principals).identifiers == toset(["cloudfront.amazonaws.com"]) &&
      one(s.condition).test == "StringEquals" &&
      one(s.condition).variable == "AWS:SourceArn" &&
      one(s.condition).values == tolist([aws_cloudfront_distribution.frontend.arn])
    ) : true])
    error_message = "The reports bucket grants CloudFront s3:GetObject on reports/* for this distribution (AWS:SourceArn) only."
  }
  assert {
    condition     = length([for s in data.aws_iam_policy_document.reports_bucket_policy.statement : s if s.sid == "AllowCloudFrontReadReportPdfs"]) == 1
    error_message = "The CloudFront read grant must be present (positive control for the check above)."
  }

  # --- The keys: operator-generated; public halves trusted, private half from sops -----------
  assert {
    condition = (
      keys(aws_cloudfront_public_key.report_downloads) == ["2026-09"] &&
      aws_cloudfront_public_key.report_downloads["2026-09"].encoded_key == var.report_download_public_keys["2026-09"] &&
      aws_cloudfront_public_key.report_downloads["2026-09"].name == "water-management-report-downloads-2026-09"
    )
    error_message = "One CloudFront public key per report_download_public_keys entry, from its PEM."
  }
  assert {
    condition     = aws_cloudfront_key_group.report_downloads.items == toset(["K2026090000000A"])
    error_message = "The key group trusts exactly the configured public keys."
  }
  assert {
    condition = (
      aws_lambda_function.backend.environment[0].variables["CLOUDFRONT_KEY_PAIR_ID"] == aws_cloudfront_public_key.report_downloads["2026-09"].id &&
      aws_lambda_function.backend.environment[0].variables["CLOUDFRONT_PUBLIC_KEY"] == var.report_download_public_keys["2026-09"]
    )
    error_message = "The API names the signing key's id (Key-Pair-Id) and gets its public PEM, which it matches its private key against at cold start."
  }
}

# ---------------------------------------------------------------------------
# Issued evidence packs' PDFs (packs.tf, s3_cloudfront.tf; 119_pack_render):
# a private bucket that keeps every PDF (versioned, Object Lock, nothing
# expires), written only by the renderer under packs/, read only by
# CloudFront's /packs/* behaviour for signed URLs.
# ---------------------------------------------------------------------------

run "packs" {
  command = plan

  # --- The bucket: private, encrypted, TLS only, kept ----------------------------------
  assert {
    condition = (
      aws_s3_bucket_public_access_block.packs.block_public_acls &&
      aws_s3_bucket_public_access_block.packs.block_public_policy &&
      aws_s3_bucket_public_access_block.packs.ignore_public_acls &&
      aws_s3_bucket_public_access_block.packs.restrict_public_buckets
    )
    error_message = "The packs bucket must block every kind of public access."
  }
  assert {
    condition     = one([for r in aws_s3_bucket_server_side_encryption_configuration.packs.rule : one(r.apply_server_side_encryption_by_default).sse_algorithm]) == "AES256"
    error_message = "Pack PDFs must be encrypted at rest (SSE-S3)."
  }
  assert {
    condition     = one([for r in aws_s3_bucket_ownership_controls.packs.rule : r.object_ownership]) == "BucketOwnerEnforced"
    error_message = "ACLs off: the bucket owner owns every object."
  }
  assert {
    condition = (
      aws_s3_bucket.packs.object_lock_enabled &&
      one(aws_s3_bucket_versioning.packs.versioning_configuration).status == "Enabled" &&
      one(one(aws_s3_bucket_object_lock_configuration.packs.rule).default_retention).mode == "GOVERNANCE" &&
      one(one(aws_s3_bucket_object_lock_configuration.packs.rule).default_retention).days == var.pack_retention_days &&
      var.pack_retention_days == 3650
    )
    error_message = "Every pack PDF is kept: a versioned bucket with an Object Lock default retention (GOVERNANCE, pack_retention_days, 10 years by default)."
  }
  assert {
    condition     = contains([for s in data.aws_iam_policy_document.packs_bucket_policy.statement : s.sid if s.effect == "Deny"], "DenyInsecureTransport")
    error_message = "The packs bucket must refuse plain-HTTP access."
  }
  assert {
    condition = (
      length([for s in data.aws_iam_policy_document.packs_bucket_policy.statement : s if s.effect != "Deny"]) == 1 &&
      one([for s in data.aws_iam_policy_document.packs_bucket_policy.statement : s.sid if s.effect != "Deny"]) == "AllowCloudFrontReadPackPdfs" &&
      toset(one([for s in data.aws_iam_policy_document.packs_bucket_policy.statement : s.actions if s.effect != "Deny"])) == toset(["s3:GetObject"]) &&
      toset(one([for s in data.aws_iam_policy_document.packs_bucket_policy.statement : s.resources if s.effect != "Deny"])) == toset(["${aws_s3_bucket.packs.arn}/packs/*"]) &&
      tolist(one(one([for s in data.aws_iam_policy_document.packs_bucket_policy.statement : s.condition if s.effect != "Deny"])).values) == tolist([aws_cloudfront_distribution.frontend.arn])
    )
    error_message = "The packs bucket policy's only grant is this distribution's GetObject of packs/* (the API never reads the bucket, it signs CloudFront URLs)."
  }

  # --- Least privilege: the renderer puts, and nothing else ----------------------------------
  assert {
    condition = (
      length(data.aws_iam_policy_document.renderer_packs.statement) == 1 &&
      toset(data.aws_iam_policy_document.renderer_packs.statement[0].actions) == toset(["s3:PutObject"]) &&
      toset(data.aws_iam_policy_document.renderer_packs.statement[0].resources) == toset(["${aws_s3_bucket.packs.arn}/packs/*"]) &&
      aws_iam_role_policy.renderer_packs.role == aws_iam_role.renderer_lambda.id
    )
    error_message = "The renderer may only put pack PDFs under packs/: never read, list, delete, change a retention or bypass it."
  }

  # --- The download behaviour and its origin ----------------------------------------------
  assert {
    condition = length([for b in aws_cloudfront_distribution.frontend.ordered_cache_behavior : b if b.path_pattern == "/packs/*"]) == 1 && alltrue([for b in aws_cloudfront_distribution.frontend.ordered_cache_behavior : (
      b.target_origin_id == "s3-packs" &&
      b.trusted_key_groups == tolist([aws_cloudfront_key_group.report_downloads.id]) &&
      b.viewer_protocol_policy == "https-only" &&
      toset(b.allowed_methods) == toset(["GET", "HEAD"]) &&
      b.cache_policy_id == "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" &&
      b.origin_request_policy_id == aws_cloudfront_origin_request_policy.report_downloads.id &&
      b.response_headers_policy_id == "api-headers-policy-id"
    ) if b.path_pattern == "/packs/*"])
    error_message = "/packs/* must serve the packs bucket only to CloudFront signed URLs from the download key group, uncached, GET/HEAD over https, with the API's security headers."
  }
  assert {
    condition = alltrue([for o in aws_cloudfront_distribution.frontend.origin :
      o.domain_name == aws_s3_bucket.packs.bucket_regional_domain_name && o.origin_access_control_id == aws_cloudfront_origin_access_control.packs.id
    if o.origin_id == "s3-packs"]) && length([for o in aws_cloudfront_distribution.frontend.origin : o if o.origin_id == "s3-packs"]) == 1
    error_message = "The s3-packs origin must be the packs bucket, read through its own OAC."
  }
  assert {
    condition = (
      aws_cloudfront_origin_access_control.packs.origin_access_control_origin_type == "s3" &&
      aws_cloudfront_origin_access_control.packs.signing_behavior == "always" &&
      aws_cloudfront_origin_access_control.packs.signing_protocol == "sigv4"
    )
    error_message = "The packs OAC must sign every origin request (sigv4)."
  }

  # --- The worker checks the renderer's answer against the stored object ------------------
  assert {
    condition = (
      length(data.aws_iam_policy_document.worker_packs.statement) == 1 &&
      toset(data.aws_iam_policy_document.worker_packs.statement[0].actions) == toset(["s3:GetObject"]) &&
      toset(data.aws_iam_policy_document.worker_packs.statement[0].resources) == toset(["${aws_s3_bucket.packs.arn}/packs/*"]) &&
      aws_iam_role_policy.worker_packs.role == aws_iam_role.worker_lambda.id &&
      aws_lambda_function.worker.environment[0].variables["PACKS_BUCKET"] == aws_s3_bucket.packs.bucket
    )
    error_message = "The worker may only read (HEAD) pack PDFs under packs/, to check the renderer's answer before recording its hash; it knows the packs bucket (PACKS_BUCKET)."
  }
  assert {
    condition = (
      aws_vpc_endpoint.s3.vpc_endpoint_type == "Interface" &&
      aws_vpc_endpoint.s3.service_name == "com.amazonaws.af-south-1.s3" &&
      aws_vpc_endpoint.s3.private_dns_enabled &&
      length(aws_vpc_endpoint.s3.subnet_ids) == 1 &&
      length(aws_vpc_endpoint.s3.security_group_ids) == 1 &&
      can(regex("security_group_ids\\s*=\\s*\\[aws_security_group\\.vpce_s3\\.id\\]", regex("(?s)resource \"aws_vpc_endpoint\" \"s3\" \\{.*?\\n\\}", file("packs.tf")))) &&
      length(data.aws_iam_policy_document.s3_endpoint.statement) == 10 &&
      toset(data.aws_iam_policy_document.s3_endpoint.statement[0].actions) == toset(["s3:GetObject"]) &&
      toset(data.aws_iam_policy_document.s3_endpoint.statement[0].resources) == toset(["${aws_s3_bucket.packs.arn}/packs/*"]) &&
      toset(one(data.aws_iam_policy_document.s3_endpoint.statement[0].principals).identifiers) == toset([aws_iam_role.worker_lambda.arn]) &&
      toset(data.aws_iam_policy_document.s3_endpoint.statement[1].actions) == toset(["s3:PutObject"]) &&
      toset(data.aws_iam_policy_document.s3_endpoint.statement[1].resources) == toset(["${aws_s3_bucket.packs.arn}/packs/*.zip"]) &&
      toset(one(data.aws_iam_policy_document.s3_endpoint.statement[1].principals).identifiers) == toset([aws_iam_role.lambda.arn]) &&
      toset(data.aws_iam_policy_document.s3_endpoint.statement[2].actions) == toset(["s3:GetObject"]) &&
      toset(data.aws_iam_policy_document.s3_endpoint.statement[2].resources) == toset(["${aws_s3_bucket.tiles.arn}/tiles/terrain.pmtiles"]) &&
      toset(one(data.aws_iam_policy_document.s3_endpoint.statement[2].principals).identifiers) == toset([aws_iam_role.lambda.arn, aws_iam_role.worker_lambda.arn]) &&
      toset(data.aws_iam_policy_document.s3_endpoint.statement[3].actions) == toset(["s3:GetObject"]) &&
      toset(data.aws_iam_policy_document.s3_endpoint.statement[3].resources) == toset(["${aws_s3_bucket.tiles.arn}/tiles/water.pmtiles"]) &&
      toset(one(data.aws_iam_policy_document.s3_endpoint.statement[3].principals).identifiers) == toset([aws_iam_role.lambda.arn]) &&
      toset(data.aws_iam_policy_document.s3_endpoint.statement[4].actions) == toset(["s3:GetObject"]) &&
      toset(data.aws_iam_policy_document.s3_endpoint.statement[4].resources) == toset(["${aws_s3_bucket.reference.arn}/reference/*"]) &&
      toset(one(data.aws_iam_policy_document.s3_endpoint.statement[4].principals).identifiers) == toset([aws_iam_role.migrate_lambda.arn]) &&
      toset(data.aws_iam_policy_document.s3_endpoint.statement[5].actions) == toset(["s3:GetObject", "s3:ListBucket"]) &&
      toset(data.aws_iam_policy_document.s3_endpoint.statement[5].resources) == toset([aws_s3_bucket.mirror.arn, "${aws_s3_bucket.mirror.arn}/*"]) &&
      toset(one(data.aws_iam_policy_document.s3_endpoint.statement[5].principals).identifiers) == toset([aws_iam_role.worker_lambda.arn]) &&
      toset(data.aws_iam_policy_document.s3_endpoint.statement[6].actions) == toset(["s3:PutObject"]) &&
      toset(data.aws_iam_policy_document.s3_endpoint.statement[6].resources) == toset(["${aws_s3_bucket.mirror.arn}/dws/stations.json"]) &&
      toset(one(data.aws_iam_policy_document.s3_endpoint.statement[6].principals).identifiers) == toset([aws_iam_role.worker_lambda.arn]) &&
      toset(data.aws_iam_policy_document.s3_endpoint.statement[7].actions) == toset(["s3:PutObject"]) &&
      toset(data.aws_iam_policy_document.s3_endpoint.statement[7].resources) == toset(["${aws_s3_bucket.mirror.arn}/dams/wanted.json"]) &&
      toset(one(data.aws_iam_policy_document.s3_endpoint.statement[7].principals).identifiers) == toset([aws_iam_role.worker_lambda.arn]) &&
      toset(data.aws_iam_policy_document.s3_endpoint.statement[8].actions) == toset(["s3:PutObject"]) &&
      toset(data.aws_iam_policy_document.s3_endpoint.statement[8].resources) == toset(["${aws_s3_bucket.mirror.arn}/et/wanted.json"]) &&
      toset(one(data.aws_iam_policy_document.s3_endpoint.statement[8].principals).identifiers) == toset([aws_iam_role.worker_lambda.arn]) &&
      toset(data.aws_iam_policy_document.s3_endpoint.statement[9].actions) == toset(["s3:DeleteObject"]) &&
      toset(data.aws_iam_policy_document.s3_endpoint.statement[9].resources) == toset(["${aws_s3_bucket.reports.arn}/reports/*"]) &&
      toset(one(data.aws_iam_policy_document.s3_endpoint.statement[9].principals).identifiers) == toset([aws_iam_role.worker_lambda.arn])
    )
    error_message = "The worker, the API and migrate reach S3 through one interface endpoint whose policy allows only the worker's read of packs/, the API's put of a bundle (packs/*.zip), the API's and the worker's reads of the delineation DEM (tiles/terrain.pmtiles), the API's of the dam-trace water (tiles/water.pmtiles), migrate's read of a reference file (reference/*), the worker's read of the data mirror (ingest.tf), the worker's put of the weekly DWS pass's station list (dws/stations.json, feeds.tf), the worker's put of the dam observations' wanted list (dams/wanted.json, dam_observations.tf), the worker's put of the observed ET's wanted list (et/wanted.json, et_observations.tf), and the worker's delete of a deleted report's PDF (reports/*, reports.tf worker_report_erasure)."
  }
  assert {
    condition = (
      length(data.aws_iam_policy_document.api_pack_bundles.statement) == 1 &&
      toset(data.aws_iam_policy_document.api_pack_bundles.statement[0].actions) == toset(["s3:PutObject"]) &&
      toset(data.aws_iam_policy_document.api_pack_bundles.statement[0].resources) == toset(["${aws_s3_bucket.packs.arn}/packs/*.zip"]) &&
      aws_iam_role_policy.api_pack_bundles.role == aws_iam_role.lambda.id &&
      aws_lambda_function.backend.environment[0].variables["PACKS_BUCKET"] == aws_s3_bucket.packs.bucket
    )
    error_message = "The API may only put a pack's reproduction bundle (packs/*.zip) in the packs bucket: no read, list, delete or retention change; it knows the bucket (PACKS_BUCKET)."
  }
}

# A pack is evidence: under a year's retention is refused (positive control: run packs plans the default).
run "rejects_short_pack_retention" {
  command = plan

  variables {
    pack_retention_days = 30
  }

  expect_failures = [var.pack_retention_days]
}
