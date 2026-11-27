# Plan-only guardrail tests against mocked providers: no AWS credentials, no
# state, no sops key (the runtime secrets are ephemeral variables, set to
# synthetic values below). They pin the production guardrails that
# `terraform validate` can't see. This file: the production baseline (Lambda runtimes and sizing, the database, the
# DATABASE_URL shape), the redirect domains, the runtime secrets (in Secrets
# Manager, never a Lambda environment) and the plan-time rejection of malformed
# ones, and the billing switches (BILLING_ENFORCED, REVERSE_TRIAL, Stripe).
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

run "production_guardrails" {
  command = plan

  # --- API Lambda --------------------------------------------------------
  assert {
    condition     = aws_lambda_function.backend.runtime == "nodejs24.x" && aws_lambda_function.migrate.runtime == "nodejs24.x"
    error_message = "Both Lambdas must run nodejs24.x."
  }
  assert {
    condition     = aws_lambda_function.backend.memory_size == 1024 && aws_lambda_function.backend.timeout == 30
    error_message = "API Lambda must default to 1024 MB / 30 s for model runs."
  }
  assert {
    condition     = aws_lambda_function.backend.reserved_concurrent_executions == 25
    error_message = "API Lambda concurrency must be capped at 25 by default (spend + DB connections; issue #541: the Project tab's ~10 panels throttled at 10)."
  }
  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["DB_POOL_MAX"] == "2" && aws_lambda_function.worker.environment[0].variables["DB_POOL_MAX"] == "2"
    error_message = "The API and the worker each hold a pg pool of DB_POOL_MAX = 2: a container serves one request or job at a time, and the cap x pool sums are sized on it (infra/README.md § Connections)."
  }
  assert {
    # The worst case every DB-connected Lambda can open at once: each cap x its
    # pool, plus the migrator's 2. It must leave db.t4g.micro (~80
    # max_connections, the default class) room for the operator and RDS's own.
    condition = (
      aws_lambda_function.backend.reserved_concurrent_executions * tonumber(aws_lambda_function.backend.environment[0].variables["DB_POOL_MAX"]) +
      aws_lambda_function.worker.reserved_concurrent_executions * tonumber(aws_lambda_function.worker.environment[0].variables["DB_POOL_MAX"]) +
      aws_lambda_function.migrate.reserved_concurrent_executions * 2
    ) <= 70
    error_message = "API cap x pool + worker cap x pool + the migrator must stay <= 70 connections (db.t4g.micro's ~80 less headroom). Redo infra/README.md § Connections before raising a cap or a pool."
  }
  assert {
    condition     = startswith(local.runtime_secrets.api.DATABASE_URL, "postgresql://water_app:") && endswith(local.runtime_secrets.api.DATABASE_URL, "@water-management.abc123.af-south-1.rds.amazonaws.com:5432/water?sslmode=verify-full")
    error_message = "DATABASE_URL (in the API's runtime secret) must connect as water_app to the RDS endpoint with sslmode=verify-full."
  }
  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["ALLOWED_ORIGINS"] == "https://icwbt.jaredhoward.com"
    error_message = "ALLOWED_ORIGINS must be exactly the site origin."
  }
  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["COOKIE_SECURE"] == "true"
    error_message = "COOKIE_SECURE must be on in production."
  }
  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["NODE_EXTRA_CA_CERTS"] == "/var/task/rds-global-bundle.pem"
    error_message = "The API must trust the RDS CA bundle shipped in its zip."
  }
  assert {
    condition     = !contains(keys(aws_lambda_function.backend.environment[0].variables), "MASTER_SECRET_ARN")
    error_message = "The API Lambda must never be given the owner credentials."
  }
  assert {
    condition     = length(aws_subnet.private) == 2 && length(aws_lambda_function.backend.vpc_config) == 1
    error_message = "API Lambda must run in the VPC, which has two private subnets."
  }
  assert {
    condition     = length(aws_lambda_function_url.backend.cors) == 0
    error_message = "The Function URL must not carry a CORS block — the browser never calls it."
  }

  # --- Migrate Lambda ----------------------------------------------------
  assert {
    condition     = aws_lambda_function.migrate.handler == "dist/lambda-migrate.handler"
    error_message = "Migrate handler must match the package layout (dist/ next to migrations/)."
  }
  assert {
    condition     = aws_lambda_function.migrate.environment[0].variables["MASTER_SECRET_ARN"] == aws_db_instance.main.master_user_secret[0].secret_arn
    error_message = "Migrate Lambda must read the RDS-managed master secret."
  }

  # --- RDS -----------------------------------------------------------------
  assert {
    condition     = aws_db_instance.main.engine == "postgres" && aws_db_instance.main.engine_version == "17"
    error_message = "Database must be PostgreSQL 17 (same major as local dev)."
  }
  # A major upgrade replaces the parameter group (new family), so it must be
  # create-before-destroy under a generated name: a fixed `name` collides with
  # the group the instance is still using (rds.tf § locals).
  # Lifecycle settings aren't plan attributes, so that half reads the source
  # (the resource block, up to its closing brace at column 0).
  assert {
    condition = (
      aws_db_parameter_group.main.name_prefix == "water-management-pg17-"
      && aws_db_parameter_group.main.family == "postgres17"
      && can(regex("create_before_destroy\\s*=\\s*true", regex("(?s)resource \"aws_db_parameter_group\" \"main\" \\{.*?\\n\\}", file("rds.tf"))))
    )
    error_message = "The DB parameter group must use name_prefix (never a fixed name), the postgres17 family, and lifecycle { create_before_destroy = true }."
  }
  assert {
    condition     = aws_db_instance.main.instance_class == "db.t4g.micro" && aws_db_instance.main.multi_az == false
    error_message = "Default DB must be single-AZ db.t4g.micro."
  }
  assert {
    condition     = aws_db_instance.main.storage_encrypted && aws_db_instance.main.deletion_protection && !aws_db_instance.main.publicly_accessible
    error_message = "DB must be encrypted, deletion-protected and private."
  }
  assert {
    condition     = aws_db_instance.main.backup_retention_period >= 7 && aws_db_instance.main.skip_final_snapshot == false
    error_message = "DB needs >= 7 days of backups and a final snapshot."
  }
  assert {
    condition     = aws_db_instance.main.manage_master_user_password == true && aws_db_instance.main.password == null
    error_message = "The master password must be RDS-managed (never in Terraform state)."
  }
  assert {
    condition     = aws_db_instance.main.performance_insights_enabled == false
    error_message = "Performance Insights stays off (cost)."
  }
  # infra/scripts/restore-db.sh restores into these, read from the outputs
  # (the parameter group's name has a generated suffix). The two computed ones
  # are unknown under mocks, so their wiring is read from the source.
  assert {
    condition = (
      output.db_instance_identifier == "water-management"
      && output.db_subnet_group_name == "water-management-db"
      && can(regex("output \"db_security_group_id\" \\{[^}]*value\\s*=\\s*aws_security_group\\.rds\\.id\\s", file("outputs.tf")))
      && can(regex("output \"db_parameter_group_name\" \\{[^}]*value\\s*=\\s*aws_db_parameter_group\\.main\\.name\\s", file("outputs.tf")))
    )
    error_message = "restore-db.sh needs the db_instance_identifier, db_subnet_group_name, db_security_group_id and db_parameter_group_name outputs, wired to the live instance's."
  }

  # --- Edge ----------------------------------------------------------------
  assert {
    condition     = aws_cloudfront_distribution.frontend.aliases == toset(["icwbt.jaredhoward.com", "water-management.jaredhoward.com"])
    error_message = "CloudFront must serve exactly the site's hostname and its former ones (redirect_domains)."
  }
  assert {
    condition     = length(aws_cloudfront_distribution.frontend.custom_error_response) == 0
    error_message = "No distribution-wide custom error responses — they would rewrite API 403/404 JSON into index.html. The SPA fallback is the spa_rewrite function."
  }
  assert {
    condition     = strcontains(aws_cloudfront_function.spa_rewrite.code, "var PRERENDERED = ['/welcome', '/welcome/af', '/welcome/pricing', '/welcome/pricing/af', '/privacy', '/terms', '/methods', '/data-sources'];") && strcontains(aws_cloudfront_function.spa_rewrite.code, "if (PRERENDERED.indexOf(uri) !== -1) {") && strcontains(aws_cloudfront_function.spa_rewrite.code, "request.uri = uri + '.html'")
    error_message = "The prerendered pages (/welcome, /welcome/af, /welcome/pricing, /welcome/pricing/af, /privacy, /terms, /methods, /data-sources) must be served from their .html, not the SPA fallback."
  }
  assert {
    condition     = aws_acm_certificate.frontend.domain_name == "icwbt.jaredhoward.com" && toset(aws_acm_certificate.frontend.subject_alternative_names) == toset(["water-management.jaredhoward.com"])
    error_message = "Certificate must be for the site's hostname, with each former hostname (redirect_domains) as a SAN."
  }

  # The former hostname (issue #551): validated and aliased in its own zone,
  # the site's in the site's.
  assert {
    condition = (
      aws_route53_record.cert_validation["icwbt.jaredhoward.com"].zone_id == "Z0000000000000000000" &&
      aws_route53_record.cert_validation["water-management.jaredhoward.com"].zone_id == "Z1111111111111111111" &&
      aws_route53_record.cert_validation["water-management.jaredhoward.com"].name == "_89abcdef.water-management.jaredhoward.com."
    )
    error_message = "Each certificate name is validated in the zone that holds it."
  }
  assert {
    condition = alltrue([for r in [aws_route53_record.site_a, aws_route53_record.site_aaaa] :
      keys(r) == ["icwbt.jaredhoward.com", "water-management.jaredhoward.com"] &&
      r["icwbt.jaredhoward.com"].zone_id == "Z0000000000000000000" && r["icwbt.jaredhoward.com"].name == "icwbt.jaredhoward.com" &&
      r["water-management.jaredhoward.com"].zone_id == "Z1111111111111111111" && r["water-management.jaredhoward.com"].name == "water-management.jaredhoward.com"
    ])
    error_message = "Both hostnames need A and AAAA aliases, each in its own zone."
  }
  assert {
    condition = alltrue([for s in [
      "var SITE_HOST = 'icwbt.jaredhoward.com';",
      "if (host && host !== SITE_HOST) return moved(request);",
      "statusCode: 301",
      "var qs = request.rawQueryString();",
      "location: { value: 'https://' + SITE_HOST + request.uri + (qs === undefined ? '' : '?' + qs) }",
    ] : strcontains(aws_cloudfront_function.spa_rewrite.code, s)])
    error_message = "spa_rewrite must 301 any other host to the same path and the query as sent (rawQueryString) on the site's hostname (infra/scripts/cloudfront-functions.test.mjs runs it)."
  }
  assert {
    condition     = alltrue([for f in [aws_cloudfront_function.api_strip_prefix, aws_cloudfront_function.tiles_range] : !strcontains(f.code, "SITE_HOST")])
    error_message = "Only pages redirect: /api/* (one-click unsubscribe, logger pushes) and /tiles/* keep answering on a former hostname."
  }
  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["ALLOWED_ORIGINS"] == "https://icwbt.jaredhoward.com"
    error_message = "A former hostname is never an allowed origin: its pages redirect, so no page there calls the API."
  }
}

# With every former hostname retired: the site's hostname alone.
run "no_redirect_domains" {
  command = plan

  variables {
    redirect_domains = {}
  }

  # ACM returns a validation option per name on the certificate: here, one.
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
      }]
    }
  }

  assert {
    condition     = aws_cloudfront_distribution.frontend.aliases == toset(["icwbt.jaredhoward.com"]) && length(aws_acm_certificate.frontend.subject_alternative_names) == 0
    error_message = "With redirect_domains = {}, CloudFront and the certificate cover the site's hostname only."
  }
  assert {
    condition     = keys(aws_route53_record.site_a) == ["icwbt.jaredhoward.com"] && keys(aws_route53_record.site_aaaa) == ["icwbt.jaredhoward.com"]
    error_message = "With redirect_domains = {}, only the site's hostname has alias records."
  }
}

run "redirect_domains_cannot_name_the_site" {
  command = plan

  variables {
    redirect_domains = { "icwbt.jaredhoward.com" = "Z1111111111111111111" }
  }

  expect_failures = [var.redirect_domains]
}

run "redirect_domains_need_hostnames_and_zone_ids" {
  command = plan

  variables {
    redirect_domains = { "https://water-management.jaredhoward.com/" = "not-a-zone" }
  }

  expect_failures = [var.redirect_domains]
}

# ---------------------------------------------------------------------------
# Runtime secrets (secrets.tf, issue #126): Secrets Manager, never a Lambda
# environment, which any GetFunctionConfiguration caller can read.
# ---------------------------------------------------------------------------

run "runtime_secrets" {
  command = plan

  # The denylist, across every Lambda: no secret in any environment block.
  # (The renderer exists only with an image tag; reports_renderer_created_from_its_image
  # checks its block the same way.)
  assert {
    condition = alltrue(flatten([
      for f in [aws_lambda_function.backend, aws_lambda_function.worker, aws_lambda_function.migrate, aws_lambda_function.fetcher] : [
        for k in keys(f.environment[0].variables) : !contains(["AUTH_JWT_SECRET", "DATABASE_URL", "CLOUDFRONT_SHARED_SECRET", "ALERTS_TOKEN_SECRET", "WATER_APP_PASSWORD"], k) && !can(regex("PASSWORD|PRIVATE_KEY|TOKEN$|SECRET$", k))
      ]
    ]))
    error_message = "No Lambda environment block may hold a secret (the session key, DATABASE_URL, the CloudFront header, the unsubscribe key, the water_app password): they belong in the runtime secret (secrets.tf)."
  }
  # Positive control: the denylist would see a secret if one were there.
  assert {
    condition     = contains(keys(local.runtime_secrets.api), "AUTH_JWT_SECRET") && contains(keys(local.runtime_secrets.migrate), "WATER_APP_PASSWORD") && can(regex("PASSWORD|PRIVATE_KEY|TOKEN$|SECRET$", "ALERTS_TOKEN_SECRET"))
    error_message = "The runtime secrets must hold the values the denylist keeps out of the environments."
  }

  # Exactly the keys each role uses (RUNTIME_SECRETS in backend/src/config/runtimeSecrets.ts).
  assert {
    condition = (
      toset(keys(local.runtime_secrets)) == toset(["api", "migrate", "worker", "assistant", "fetcher"]) &&
      toset(keys(local.runtime_secrets.api)) == toset(["AUTH_JWT_SECRET", "DATABASE_URL", "CLOUDFRONT_SHARED_SECRET", "CLOUDFRONT_PRIVATE_KEY", "APP_ENCRYPTION_KEY", "STRIPE_SECRET_KEY", "BILLING_WEBHOOK_SECRET"]) &&
      toset(keys(local.runtime_secrets.worker)) == toset(["AUTH_JWT_SECRET", "DATABASE_URL", "ALERTS_TOKEN_SECRET"]) &&
      toset(keys(local.runtime_secrets.migrate)) == toset(["WATER_APP_PASSWORD"]) &&
      toset(keys(local.runtime_secrets.assistant)) == toset(["AUTH_JWT_SECRET", "DATABASE_URL", "CLOUDFRONT_SHARED_SECRET"]) &&
      toset(keys(local.runtime_secrets.fetcher)) == toset(["FEED_CREDENTIAL_PRIVATE_KEY"])
    )
    error_message = "Each runtime secret holds exactly its Lambda's keys: the download signing key and the TOTP sealing key for the API only (the edge secret for the API and the assistant), the unsubscribe key for the worker only, the water_app password for migrate only."
  }
  # Billing is manual by default (issue #641): the API's secret as written
  # holds no Stripe key, not even an empty one (the backend refuses a key it
  # doesn't expect under manual, runtimeSecrets.ts ONLY_WHEN), and nothing
  # else is dropped.
  assert {
    condition = (
      var.billing_provider == "manual" && var.stripe_secret_key == "" && var.billing_webhook_secret == "" &&
      toset(keys(local.runtime_secrets_written.api)) == toset(["AUTH_JWT_SECRET", "DATABASE_URL", "CLOUDFRONT_SHARED_SECRET", "CLOUDFRONT_PRIVATE_KEY", "APP_ENCRYPTION_KEY"]) &&
      alltrue([for role in ["worker", "migrate", "assistant", "fetcher"] : toset(keys(local.runtime_secrets_written[role])) == toset(keys(local.runtime_secrets[role]))])
    )
    error_message = "With billing_provider = manual (the default) the API's runtime secret holds no Stripe key, and every other secret holds all its keys."
  }
  assert {
    condition = (
      local.runtime_secrets.migrate.WATER_APP_PASSWORD == var.db_app_password &&
      local.runtime_secrets.api.AUTH_JWT_SECRET == var.auth_jwt_secret &&
      local.runtime_secrets.api.APP_ENCRYPTION_KEY == var.app_encryption_key &&
      local.runtime_secrets.worker.ALERTS_TOKEN_SECRET == var.alerts_token_secret
    )
    error_message = "The runtime secrets carry the values from their sources (the sops-fed variables)."
  }

  # Out of state (issue #126). Every version is written write-only: the plan
  # holds no secret_string (a plain one would put the JSON in state), the
  # write-only argument reads back null (Terraform keeps no copy), and the
  # counter is the one thing that says when to write again.
  assert {
    condition = alltrue([for k, v in aws_secretsmanager_secret_version.runtime :
      v.secret_string == null && v.secret_string_wo == null && v.secret_string_wo_version == var.runtime_secret_version
    ])
    error_message = "Every runtime secret version must use secret_string_wo + secret_string_wo_version (var.runtime_secret_version), never secret_string: a plain secret_string puts the values in state."
  }
  assert {
    condition     = toset(keys(aws_secretsmanager_secret_version.runtime)) == toset(["api", "migrate", "worker"])
    error_message = "Each runtime secret has one write-only version (the check above ranges over them all)."
  }
  # The values are ephemeral, so Terraform refuses to store them anywhere:
  # ephemeralasnull() turns an ephemeral value into null and leaves any other
  # alone. Positive control: the CloudFront header is not ephemeral (its
  # custom_header argument is not write-only, so it stays in state by design;
  # secrets.tf), and ephemeralasnull keeps it.
  assert {
    condition = alltrue([
      ephemeralasnull(var.auth_jwt_secret) == null,
      ephemeralasnull(var.db_app_password) == null,
      ephemeralasnull(var.alerts_token_secret) == null,
      ephemeralasnull(var.cloudfront_private_key) == null,
      ephemeralasnull(var.app_encryption_key) == null,
      ephemeralasnull(local.runtime_secrets.api.CLOUDFRONT_PRIVATE_KEY) == null,
      ephemeralasnull(local.runtime_secrets.api.DATABASE_URL) == null,
      ephemeralasnull(local.runtime_secrets.worker.DATABASE_URL) == null,
      ephemeralasnull(local.runtime_secrets.migrate.WATER_APP_PASSWORD) == null,
    ])
    error_message = "The sops values, and DATABASE_URL built from one, must be ephemeral, so no state or plan can hold them."
  }
  assert {
    condition     = ephemeralasnull(local.runtime_secrets.api.CLOUDFRONT_SHARED_SECRET) != null
    error_message = "Positive control: ephemeralasnull keeps a non-ephemeral value (the CloudFront header, the one runtime value left in state)."
  }
  assert {
    condition     = local.runtime_secrets.api.CLOUDFRONT_PRIVATE_KEY == var.cloudfront_private_key
    error_message = "The API's runtime secret carries the report-download signing key from its sops-fed variable, the same path as the session key."
  }

  # Each Lambda names its own secret and the version Terraform wrote (a new
  # version changes the variable, so a rotation cold-starts every instance).
  assert {
    condition = (
      aws_lambda_function.backend.environment[0].variables["RUNTIME_SECRET_VERSION"] == aws_secretsmanager_secret_version.runtime["api"].version_id &&
      aws_lambda_function.worker.environment[0].variables["RUNTIME_SECRET_VERSION"] == aws_secretsmanager_secret_version.runtime["worker"].version_id &&
      aws_lambda_function.migrate.environment[0].variables["RUNTIME_SECRET_VERSION"] == aws_secretsmanager_secret_version.runtime["migrate"].version_id
    )
    error_message = "RUNTIME_SECRET_VERSION must be the version_id of the Lambda's own runtime secret version, which changes whenever runtime_secret_version is raised."
  }
  assert {
    condition = (
      aws_lambda_function.backend.environment[0].variables["RUNTIME_SECRET_ARN"] == aws_secretsmanager_secret.runtime["api"].arn &&
      aws_lambda_function.worker.environment[0].variables["RUNTIME_SECRET_ARN"] == aws_secretsmanager_secret.runtime["worker"].arn &&
      aws_lambda_function.migrate.environment[0].variables["RUNTIME_SECRET_ARN"] == aws_secretsmanager_secret.runtime["migrate"].arn
    )
    error_message = "The API, worker and migrate Lambdas must each name their own runtime secret."
  }
  assert {
    condition = alltrue([for f in [aws_lambda_function.backend, aws_lambda_function.worker, aws_lambda_function.migrate] :
      contains(keys(f.environment[0].variables), "RUNTIME_SECRET_VERSION")
    ])
    error_message = "Each Lambda with a runtime secret must pin its version (RUNTIME_SECRET_VERSION), so a rotation reaches it."
  }
  assert {
    condition     = !contains(keys(aws_lambda_function.fetcher.environment[0].variables), "RUNTIME_SECRET_ARN")
    error_message = "The fetcher holds no secret while station API feeds are off (the default; cutover.tftest.hcl covers on)."
  }
  assert {
    condition     = alltrue([for k, v in aws_secretsmanager_secret.runtime : v.name == "water-management/runtime/${k}"])
    error_message = "Runtime secrets are named water-management/runtime/<role>."
  }

  # IAM: each role reads its own secret, and only that one. (Positive control
  # first: the overrides give the three secrets distinct ARNs, so matching a
  # grant to "its own" secret can fail.)
  assert {
    condition     = length(toset([for s in aws_secretsmanager_secret.runtime : s.arn])) == 3
    error_message = "The test's secret ARN overrides must be distinct, or the per-role checks below prove nothing."
  }
  assert {
    condition = alltrue([for role, d in data.aws_iam_policy_document.runtime_secret :
      length(d.statement) == 1 && toset(d.statement[0].actions) == toset(["secretsmanager:GetSecretValue"]) && toset(d.statement[0].resources) == toset([aws_secretsmanager_secret.runtime[role].arn])
    ])
    error_message = "Each runtime-secret policy grants GetSecretValue on its own secret's ARN only."
  }
  assert {
    condition = (
      aws_iam_role_policy.runtime_secret["api"].role == aws_iam_role.lambda.id &&
      aws_iam_role_policy.runtime_secret["worker"].role == aws_iam_role.worker_lambda.id &&
      aws_iam_role_policy.runtime_secret["migrate"].role == aws_iam_role.migrate_lambda.id
    )
    error_message = "Each runtime-secret policy is attached to its own Lambda's role."
  }
  assert {
    condition = alltrue([for s in data.aws_iam_policy_document.migrate_lambda.statement :
      toset(s.resources) == toset([aws_db_instance.main.master_user_secret[0].secret_arn])
    ])
    error_message = "The migrate role's own policy reads the RDS master secret and nothing else (its runtime secret is granted separately)."
  }
  assert {
    condition     = length([for s in data.aws_iam_policy_document.github_deploy.statement : s if anytrue([for a in s.actions : startswith(a, "secretsmanager:")])]) == 0
    error_message = "The deploy role must not read any secret (it may read function configuration, which is why secrets left it)."
  }

  # The Secrets Manager endpoint: exactly the owning role per secret.
  assert {
    condition = (
      length(data.aws_iam_policy_document.secretsmanager_endpoint.statement) == 4 &&
      alltrue([for s in data.aws_iam_policy_document.secretsmanager_endpoint.statement :
        length(s.resources) == 1 && length(s.principals) == 1 && length(one(s.principals).identifiers) == 1 &&
        alltrue([for a in s.actions : !strcontains(a, "*")]) &&
        (
          (one(s.resources) == aws_db_instance.main.master_user_secret[0].secret_arn && one(one(s.principals).identifiers) == aws_iam_role.migrate_lambda.arn) ||
          (one(s.resources) == aws_secretsmanager_secret.runtime["api"].arn && one(one(s.principals).identifiers) == aws_iam_role.lambda.arn) ||
          (one(s.resources) == aws_secretsmanager_secret.runtime["worker"].arn && one(one(s.principals).identifiers) == aws_iam_role.worker_lambda.arn) ||
          (one(s.resources) == aws_secretsmanager_secret.runtime["migrate"].arn && one(one(s.principals).identifiers) == aws_iam_role.migrate_lambda.arn)
        )
      ])
    )
    error_message = "The Secrets Manager endpoint policy must let each role read only its own secret: migrate the RDS master and its runtime secret, the API and worker their runtime secrets."
  }
  assert {
    condition = toset(flatten([for s in data.aws_iam_policy_document.secretsmanager_endpoint.statement : [for p in s.principals : p.identifiers]])) == toset([
      aws_iam_role.lambda.arn, aws_iam_role.worker_lambda.arn, aws_iam_role.migrate_lambda.arn,
    ])
    error_message = "Only the API, worker and migrate roles may use the Secrets Manager endpoint."
  }

  # Network: the API and worker reach the endpoint (443 both ways), as migrate does.
  assert {
    condition = (
      aws_vpc_security_group_ingress_rule.vpce_from_api.referenced_security_group_id == aws_security_group.api_lambda.id &&
      aws_vpc_security_group_ingress_rule.vpce_from_worker.referenced_security_group_id == aws_security_group.worker_lambda.id &&
      aws_vpc_security_group_egress_rule.api_to_vpce.referenced_security_group_id == aws_security_group.vpce.id &&
      aws_vpc_security_group_egress_rule.worker_to_vpce.referenced_security_group_id == aws_security_group.vpce.id &&
      alltrue([for r in [aws_vpc_security_group_ingress_rule.vpce_from_api, aws_vpc_security_group_ingress_rule.vpce_from_worker, aws_vpc_security_group_egress_rule.api_to_vpce, aws_vpc_security_group_egress_rule.worker_to_vpce] :
        r.from_port == 443 && r.to_port == 443 && r.ip_protocol == "tcp"
      ])
    )
    error_message = "The API and worker must reach the Secrets Manager endpoint on 443 (their runtime secrets), and nothing wider."
  }
  assert {
    condition     = aws_vpc_endpoint.secretsmanager.private_dns_enabled && aws_vpc_endpoint.secretsmanager.security_group_ids == toset([aws_security_group.vpce.id])
    error_message = "Secrets Manager is reached through its private-DNS interface endpoint, guarded by the vpce security group."
  }
}

run "rejects_short_jwt_secret" {
  command = plan

  variables {
    auth_jwt_secret = "too-short"
  }

  expect_failures = [var.auth_jwt_secret]
}

run "rejects_dev_placeholder_jwt_secret" {
  command = plan

  # Long enough, so only the placeholder check can refuse it.
  variables {
    auth_jwt_secret = "dev-only-jwt-secret-change-me-0000000000"
  }

  expect_failures = [var.auth_jwt_secret]
}

run "rejects_non_alphanumeric_db_password" {
  command = plan

  variables {
    db_app_password = "has@special/chars-and-is-long-enough"
  }

  expect_failures = [var.db_app_password]
}

run "rejects_short_alerts_token_secret" {
  command = plan

  variables {
    alerts_token_secret = "0123456789abcdef"
  }

  expect_failures = [var.alerts_token_secret]
}

# The TOTP sealing key (two-step sign-in, issue #282): long, and not the
# committed dev placeholder.
run "rejects_short_app_encryption_key" {
  command = plan

  variables {
    app_encryption_key = "0123456789abcdef"
  }

  expect_failures = [var.app_encryption_key]
}

run "rejects_placeholder_app_encryption_key" {
  command = plan

  variables {
    app_encryption_key = "dev-only-app-encryption-key-0000000000000000"
  }

  expect_failures = [var.app_encryption_key]
}

# --- Enforcement and the reverse trial (issue #936; docs/deployment.md -------
# § Turning on enforcement). Off by default; the exact strings the backend
# reads ("true"/"false", billing/enforced.ts, billing/reverseTrial.ts).

run "billing_enforcement_off_by_default" {
  command = plan

  variables {
    assistant_enabled = true
  }

  assert {
    condition = (
      aws_lambda_function.backend.environment[0].variables["BILLING_ENFORCED"] == "false" &&
      aws_lambda_function.backend.environment[0].variables["REVERSE_TRIAL"] == "false" &&
      aws_lambda_function.worker.environment[0].variables["BILLING_ENFORCED"] == "false" &&
      aws_lambda_function.assistant[0].environment[0].variables["BILLING_ENFORCED"] == "false" &&
      aws_lambda_function.migrate.environment[0].variables["BILLING_ENFORCED"] == "false"
    )
    error_message = "By default BILLING_ENFORCED is \"false\" on the API, the worker, the assistant and the migrate Lambda (its owner actions), and REVERSE_TRIAL \"false\" on the API."
  }
  assert {
    # Only the API grants a trial; the Lambdas that never open a withUser
    # transaction or change a subscription read neither.
    condition = (
      !contains(keys(aws_lambda_function.worker.environment[0].variables), "REVERSE_TRIAL") &&
      !contains(keys(aws_lambda_function.assistant[0].environment[0].variables), "REVERSE_TRIAL") &&
      !contains(keys(aws_lambda_function.migrate.environment[0].variables), "REVERSE_TRIAL") &&
      alltrue([for vars in concat([aws_lambda_function.fetcher.environment[0].variables], [for r in aws_lambda_function.renderer : r.environment[0].variables]) :
        !contains(keys(vars), "BILLING_ENFORCED") && !contains(keys(vars), "REVERSE_TRIAL")
      ])
    )
    error_message = "REVERSE_TRIAL is on the API alone, and neither setting is on the fetcher or renderer Lambda."
  }
}

run "billing_enforcement_on_with_the_reverse_trial" {
  command = plan

  variables {
    assistant_enabled = true
    billing_enforced  = true
    reverse_trial     = true
  }

  assert {
    condition = (
      aws_lambda_function.backend.environment[0].variables["BILLING_ENFORCED"] == "true" &&
      aws_lambda_function.backend.environment[0].variables["REVERSE_TRIAL"] == "true" &&
      aws_lambda_function.worker.environment[0].variables["BILLING_ENFORCED"] == "true" &&
      aws_lambda_function.assistant[0].environment[0].variables["BILLING_ENFORCED"] == "true" &&
      aws_lambda_function.migrate.environment[0].variables["BILLING_ENFORCED"] == "true"
    )
    error_message = "billing_enforced and reverse_trial set BILLING_ENFORCED=\"true\" on the API, the worker, the assistant and the migrate Lambda, and REVERSE_TRIAL=\"true\" on the API."
  }
}

run "billing_enforcement_on_without_the_trial" {
  command = plan

  variables {
    billing_enforced = true
  }

  assert {
    condition = (
      aws_lambda_function.backend.environment[0].variables["BILLING_ENFORCED"] == "true" &&
      aws_lambda_function.backend.environment[0].variables["REVERSE_TRIAL"] == "false" &&
      aws_lambda_function.worker.environment[0].variables["BILLING_ENFORCED"] == "true"
    )
    error_message = "billing_enforced alone turns on BILLING_ENFORCED and leaves REVERSE_TRIAL \"false\"."
  }
}

run "reverse_trial_needs_billing_enforced" {
  command = plan

  # The backend grants no trial while enforcement is off (reverseTrialOn), so
  # plan refuses the pair rather than ship a switch that does nothing.
  variables {
    reverse_trial = true
  }

  expect_failures = [var.reverse_trial]
}

# --- Stripe billing (issue #641; docs/deployment.md § Turning on Stripe) ------
# Synthetic, live-shaped values: no real key is ever in this repo.

run "stripe_secrets_reach_the_runtime_secret_only" {
  command = plan

  variables {
    billing_provider       = "stripe"
    stripe_egress_enabled  = true
    stripe_secret_key      = "rk_live_0000synthetic0000000000"
    billing_webhook_secret = "whsec_synthetic0000000000000000000000"
  }

  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["BILLING_PROVIDER"] == "stripe"
    error_message = "billing_provider = stripe sets BILLING_PROVIDER=stripe on the API."
  }
  assert {
    condition = (
      local.runtime_secrets_written.api.STRIPE_SECRET_KEY == var.stripe_secret_key &&
      local.runtime_secrets_written.api.BILLING_WEBHOOK_SECRET == var.billing_webhook_secret &&
      toset(keys(local.runtime_secrets_written.api)) == toset(keys(local.runtime_secrets.api))
    )
    error_message = "With stripe, the API's runtime secret carries both Stripe values from their sops-fed variables, beside its other keys."
  }
  assert {
    condition = alltrue([for role in ["worker", "migrate", "assistant", "fetcher"] :
      !contains(keys(local.runtime_secrets_written[role]), "STRIPE_SECRET_KEY") && !contains(keys(local.runtime_secrets_written[role]), "BILLING_WEBHOOK_SECRET")
    ])
    error_message = "Only the API holds the Stripe pair."
  }
  assert {
    condition = alltrue([for k in keys(aws_lambda_function.backend.environment[0].variables) :
      !contains(["STRIPE_SECRET_KEY", "BILLING_WEBHOOK_SECRET"], k) && !can(regex("PASSWORD|PRIVATE_KEY|TOKEN$|SECRET$|_KEY$", k)) || contains(["CLOUDFRONT_PUBLIC_KEY", "FEED_CREDENTIAL_PUBLIC_KEY"], k)
    ])
    error_message = "Neither Stripe secret may be in the API's environment block (any GetFunctionConfiguration caller reads it): they go in its runtime secret."
  }
  assert {
    condition     = ephemeralasnull(var.stripe_secret_key) == null && ephemeralasnull(var.billing_webhook_secret) == null && ephemeralasnull(local.runtime_secrets_written.api.STRIPE_SECRET_KEY) == null
    error_message = "The Stripe values are ephemeral, so no state or plan holds them."
  }
}

run "stripe_needs_both_secrets" {
  command = plan

  variables {
    billing_provider = "stripe"
  }

  expect_failures = [var.billing_provider]
}

run "stripe_needs_the_egress" {
  command = plan

  # Both secrets right, but no way out of the private VPC to api.stripe.com.
  variables {
    billing_provider       = "stripe"
    stripe_secret_key      = "rk_live_0000synthetic0000000000"
    billing_webhook_secret = "whsec_synthetic0000000000000000000000"
  }

  expect_failures = [var.billing_provider]
}

run "stripe_needs_the_webhook_secret" {
  command = plan

  variables {
    billing_provider  = "stripe"
    stripe_secret_key = "rk_live_0000synthetic0000000000"
  }

  expect_failures = [var.billing_provider]
}

run "stripe_refuses_a_test_mode_key" {
  command = plan

  variables {
    billing_provider       = "stripe"
    stripe_egress_enabled  = true
    stripe_secret_key      = "sk_test_0000synthetic0000000000"
    billing_webhook_secret = "whsec_synthetic0000000000000000000000"
  }

  # The key's own validation fails first; billing_provider's check of it is then skipped.
  expect_failures = [var.stripe_secret_key]
}

run "stripe_refuses_a_placeholder_webhook_secret" {
  command = plan

  variables {
    billing_provider       = "stripe"
    stripe_egress_enabled  = true
    stripe_secret_key      = "rk_live_0000synthetic0000000000"
    billing_webhook_secret = "dev-only-billing-webhook-secret-00000000000"
  }

  # The secret's own validation fails first; billing_provider's check of it is then skipped.
  expect_failures = [var.billing_webhook_secret]
}

run "billing_provider_refuses_mock" {
  command = plan

  variables {
    billing_provider = "mock"
  }

  expect_failures = [var.billing_provider]
}

run "rejects_fractional_runtime_secret_version" {
  command = plan

  variables {
    runtime_secret_version = 1.5
  }

  expect_failures = [var.runtime_secret_version]
}

run "rejects_zero_runtime_secret_version" {
  command = plan

  variables {
    runtime_secret_version = 0
  }

  expect_failures = [var.runtime_secret_version]
}

run "rejects_runtime_secret_version_past_16_digits" {
  command = plan

  variables {
    runtime_secret_version = 10000000000000000
  }

  expect_failures = [var.runtime_secret_version]
}

# Rotation: scripts/tf.sh sets the counter from sops.lastmodified as
# YYYYMMDDhhmmss (14 digits: past 2^32, well inside the provider's 64-bit
# secret_string_wo_version). It must pass the variable's validation and reach
# every runtime secret version unchanged (the AWS provider replaces a version
# whose secret_string_wo_version changed, so its version_id, and each Lambda's
# RUNTIME_SECRET_VERSION with it, changes; the mocks can't show the
# replacement itself, runtime_secrets checks the wiring).
run "rotation_counter_from_sops_lastmodified" {
  command = plan

  variables {
    runtime_secret_version = 20260928081500
  }

  assert {
    condition     = alltrue([for k, v in aws_secretsmanager_secret_version.runtime : v.secret_string_wo_version == 20260928081500])
    error_message = "A lastmodified-derived runtime_secret_version (YYYYMMDDhhmmss) must pass validation and reach every runtime secret version unchanged."
  }
}
