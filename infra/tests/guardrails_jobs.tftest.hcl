# Plan-only guardrail tests against mocked providers: no AWS credentials, no
# state, no sops key (the runtime secrets are ephemeral variables, set to
# synthetic values below). They pin the production guardrails that
# `terraform validate` can't see. This file: the background-job queues, worker and SQS endpoint policy, the SES
# bounce/complaint chain to the worker, the data-feed queues and the fetcher
# outside the VPC, and the deploy role's trust pin.
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
# Background jobs (jobs.tf, WP-2.8)
# ---------------------------------------------------------------------------

run "background_jobs" {
  command = plan

  # --- Queues: SSE everywhere, a DLQ after 5 receives -------------------------
  assert {
    condition     = aws_sqs_queue.jobs.sqs_managed_sse_enabled && aws_sqs_queue.jobs_dlq.sqs_managed_sse_enabled
    error_message = "Both job queues must be encrypted at rest (SQS-managed SSE)."
  }
  assert {
    condition = (
      jsondecode(aws_sqs_queue.jobs.redrive_policy).maxReceiveCount == 5 &&
      jsondecode(aws_sqs_queue.jobs.redrive_policy).deadLetterTargetArn == aws_sqs_queue.jobs_dlq.arn
    )
    error_message = "The jobs queue must dead-letter to its DLQ after 5 receives."
  }
  assert {
    condition     = aws_sqs_queue.jobs.visibility_timeout_seconds >= 6 * aws_lambda_function.worker.timeout
    error_message = "Visibility timeout must be at least 6x the worker timeout, or messages redeliver mid-tick."
  }

  # --- Worker Lambda ------------------------------------------------------------
  assert {
    condition = (
      aws_lambda_function.worker.runtime == "nodejs24.x" &&
      aws_lambda_function.worker.handler == "lambda-worker.handler" &&
      aws_lambda_function.worker.memory_size == 1024 &&
      aws_lambda_function.worker.timeout == 300
    )
    error_message = "Worker Lambda: nodejs24.x, lambda-worker.handler, 1024 MB, 300 s."
  }
  assert {
    condition     = aws_lambda_function.worker.reserved_concurrent_executions == 8
    error_message = "Worker concurrency must be capped at 8 by default: its four SQS triggers x 2, and no more (spend + DB connections)."
  }
  assert {
    condition     = length(aws_lambda_function.worker.vpc_config) == 1 && aws_lambda_function.worker.vpc_config[0].security_group_ids == toset([aws_security_group.worker_lambda.id])
    error_message = "The worker runs in the VPC with its own security group."
  }
  assert {
    condition = (
      startswith(local.runtime_secrets.worker.DATABASE_URL, "postgresql://water_app:") &&
      strcontains(local.runtime_secrets.worker.DATABASE_URL, "sslmode=verify-full")
    )
    error_message = "The worker connects as the RLS-bound water_app over verified TLS."
  }
  assert {
    condition     = length(setintersection(keys(aws_lambda_function.worker.environment[0].variables), ["JOB_TRANSPORT", "JOBS_QUEUE_URL"])) == 0
    error_message = "The worker never wakes itself (it may not send to the jobs queue): only the API gets JOB_TRANSPORT and JOBS_QUEUE_URL."
  }
  assert {
    condition     = !contains(keys(aws_lambda_function.worker.environment[0].variables), "MASTER_SECRET_ARN")
    error_message = "The worker must never be given the owner credentials: jobs run under RLS."
  }
  assert {
    condition = (
      aws_lambda_function.backend.environment[0].variables["JOB_TRANSPORT"] == "sqs" &&
      aws_lambda_function.backend.environment[0].variables["JOBS_QUEUE_URL"] == aws_sqs_queue.jobs.url
    )
    error_message = "The API must wake the worker through the jobs queue."
  }

  # --- Triggers -------------------------------------------------------------------
  assert {
    condition     = aws_cloudwatch_event_rule.worker_tick.schedule_expression == "rate(5 minutes)" && aws_cloudwatch_event_target.worker_tick.arn == aws_lambda_function.worker.arn
    error_message = "EventBridge must tick the worker every 5 minutes."
  }
  assert {
    condition = (
      aws_cloudwatch_event_target.worker_tick.retry_policy[0].maximum_retry_attempts == 0 &&
      aws_cloudwatch_event_target.worker_tick.retry_policy[0].maximum_event_age_in_seconds == 300 &&
      aws_lambda_function_event_invoke_config.worker_tick.function_name == aws_lambda_function.worker.function_name &&
      aws_lambda_function_event_invoke_config.worker_tick.maximum_retry_attempts == 0 &&
      aws_lambda_function_event_invoke_config.worker_tick.maximum_event_age_in_seconds == 300
    )
    error_message = "A worker tick must never be retried or outlive one tick (EventBridge target and Lambda's async queue): stale ticks would pile up for hours on a struggling worker."
  }
  assert {
    condition     = aws_lambda_permission.worker_tick.principal == "events.amazonaws.com" && aws_lambda_permission.worker_tick.source_arn == aws_cloudwatch_event_rule.worker_tick.arn
    error_message = "Only the tick rule may invoke the worker through EventBridge."
  }
  assert {
    condition     = aws_lambda_event_source_mapping.worker_jobs.event_source_arn == aws_sqs_queue.jobs.arn && aws_lambda_event_source_mapping.worker_jobs.function_name == aws_lambda_function.worker.arn
    error_message = "The jobs queue must trigger the worker."
  }

  # --- SQS endpoint: private DNS, and a policy naming only our roles and queue ---
  assert {
    condition     = aws_vpc_endpoint.sqs.vpc_endpoint_type == "Interface" && aws_vpc_endpoint.sqs.private_dns_enabled && aws_vpc_endpoint.sqs.service_name == "com.amazonaws.af-south-1.sqs"
    error_message = "SQS must be reached through a private-DNS interface endpoint (no NAT)."
  }
  assert {
    condition     = length(aws_vpc_endpoint.sqs.subnet_ids) == 1
    error_message = "The SQS endpoint defaults to one AZ (sqs_endpoint_az_count, cost)."
  }
  assert {
    condition = alltrue([for s in data.aws_iam_policy_document.sqs_endpoint.statement :
      length(s.resources) == 1 && contains([aws_sqs_queue.jobs.arn, aws_sqs_queue.fetch_requests[0].arn, aws_sqs_queue.ingest_results[0].arn, aws_sqs_queue.render_requests.arn, aws_sqs_queue.render_results.arn, aws_sqs_queue.mail_events.arn], one(s.resources)) &&
      alltrue([for a in s.actions : !strcontains(a, "*")])
    ])
    error_message = "The SQS endpoint policy must name only the jobs, data-feed, render and mail-events queues, one per statement, with no wildcard actions."
  }
  assert {
    condition = toset(flatten([for s in data.aws_iam_policy_document.sqs_endpoint.statement : [for p in s.principals : p.identifiers]])) == toset([
      aws_iam_role.lambda.arn, aws_iam_role.worker_lambda.arn,
    ])
    error_message = "Only the API and worker roles may use the SQS endpoint."
  }
  assert {
    condition = alltrue(flatten([for d in [data.aws_iam_policy_document.worker_lambda, data.aws_iam_policy_document.lambda_jobs_send] : [
      for s in d.statement : toset(s.resources) == toset([aws_sqs_queue.jobs.arn])
    ]]))
    error_message = "The API and worker IAM policies reach the jobs queue only."
  }
  assert {
    condition     = contains(flatten([for s in data.aws_iam_policy_document.github_deploy.statement : s.resources if s.sid == "LambdaUpdate"]), aws_lambda_function.worker.arn)
    error_message = "The deploy role must be able to update the worker's code."
  }

  # --- Alarms -----------------------------------------------------------------------
  assert {
    condition     = aws_cloudwatch_metric_alarm.jobs_dlq_depth[0].threshold == 0 && one([for m in aws_cloudwatch_metric_alarm.jobs_dlq_depth[0].metric_query : m.metric[0].dimensions["QueueName"] if m.id == "visible"]) == aws_sqs_queue.jobs_dlq.name
    error_message = "A new message in the jobs DLQ must alarm (the arrival expression: observability.tftest.hcl)."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.jobs_backlog[0].namespace == "water-management/Jobs" && aws_cloudwatch_metric_alarm.jobs_backlog[0].metric_name == "OldestDueJobAgeSeconds"
    error_message = "The backlog alarm must read the metric lambda-worker.ts emits (METRIC_NAMESPACE, OldestDueJobAgeSeconds)."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.worker_heartbeat[0].namespace == "AWS/Lambda" &&
      aws_cloudwatch_metric_alarm.worker_heartbeat[0].metric_name == "Invocations" &&
      aws_cloudwatch_metric_alarm.worker_heartbeat[0].dimensions["FunctionName"] == aws_lambda_function.worker.function_name &&
      aws_cloudwatch_metric_alarm.worker_heartbeat[0].comparison_operator == "LessThanThreshold" &&
      aws_cloudwatch_metric_alarm.worker_heartbeat[0].threshold == 1 &&
      aws_cloudwatch_metric_alarm.worker_heartbeat[0].statistic == "Sum" &&
      aws_cloudwatch_metric_alarm.worker_heartbeat[0].period * aws_cloudwatch_metric_alarm.worker_heartbeat[0].evaluation_periods == 900 &&
      aws_cloudwatch_metric_alarm.worker_heartbeat[0].treat_missing_data == "breaching"
    )
    error_message = "The worker heartbeat must alarm on < 1 invocation in 15 minutes (three ticks), with missing data breaching: a stopped worker emits no data."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.worker_tick_failed[0].namespace == "AWS/Events" &&
      aws_cloudwatch_metric_alarm.worker_tick_failed[0].metric_name == "FailedInvocations" &&
      aws_cloudwatch_metric_alarm.worker_tick_failed[0].dimensions["RuleName"] == aws_cloudwatch_event_rule.worker_tick.name &&
      aws_cloudwatch_metric_alarm.worker_tick_failed[0].comparison_operator == "GreaterThanThreshold" &&
      aws_cloudwatch_metric_alarm.worker_tick_failed[0].threshold == 0
    )
    error_message = "EventBridge failing to deliver the worker tick must alarm (FailedInvocations > 0 on the worker-tick rule)."
  }
  assert {
    condition     = aws_cloudwatch_log_metric_filter.job_dead[0].log_group_name == aws_cloudwatch_log_group.worker.name && aws_cloudwatch_log_metric_filter.job_dead[0].pattern == "{ $.message.event = \"job_dead\" }"
    error_message = "The dead-job filter must match runner.ts's structured event in the worker's log group."
  }

  # --- Alert emails (WP-2.13) -------------------------------------------------------
  assert {
    condition = (
      contains(keys(local.runtime_secrets.worker), "ALERTS_TOKEN_SECRET") &&
      local.runtime_secrets.worker.ALERTS_TOKEN_SECRET == var.alerts_token_secret &&
      aws_lambda_function.worker.environment[0].variables["ALERTS_ENABLED"] == "true"
    )
    error_message = "The worker signs unsubscribe links (ALERTS_TOKEN_SECRET, ≥ 32 characters) and sends alerts unless the kill switch is off."
  }
  assert {
    condition     = !contains(keys(aws_lambda_function.backend.environment[0].variables), "ALERTS_TOKEN_SECRET") && !contains(keys(local.runtime_secrets.api), "ALERTS_TOKEN_SECRET")
    error_message = "Only the worker holds the unsubscribe-token secret: the API checks a token by its hash alone."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.alert_storm[0].namespace == "water-management/Jobs" && aws_cloudwatch_metric_alarm.alert_storm[0].metric_name == "AlertMailsSent" &&
      aws_cloudwatch_metric_alarm.alert_storm[0].alarm_actions == toset([aws_sns_topic.alerts.arn])
    )
    error_message = "The alert-storm alarm must read the metric lambda-worker.ts emits (AlertMailsSent) and notify the alerts topic."
  }
}

# ---------------------------------------------------------------------------
# SES bounces and complaints → the app (ses.tf, WP-2.13 follow-up)
# ---------------------------------------------------------------------------

run "mail_suppression" {
  command = plan

  # --- The event destination: bounces and complaints, to the ses-events topic ------
  assert {
    condition = (
      aws_sesv2_configuration_set_event_destination.suppression.configuration_set_name == aws_sesv2_configuration_set.main.configuration_set_name &&
      aws_sesv2_configuration_set_event_destination.suppression.event_destination[0].enabled &&
      toset(aws_sesv2_configuration_set_event_destination.suppression.event_destination[0].matching_event_types) == toset(["BOUNCE", "COMPLAINT"]) &&
      aws_sesv2_configuration_set_event_destination.suppression.event_destination[0].sns_destination[0].topic_arn == aws_sns_topic.ses_events.arn
    )
    error_message = "The configuration set publishes bounces and complaints (and nothing else) to the ses-events topic."
  }

  # --- Trust down the chain: SES (this set, this account) → topic → queue ------------
  assert {
    condition = (
      length(data.aws_iam_policy_document.ses_events_topic.statement) == 1 &&
      data.aws_iam_policy_document.ses_events_topic.statement[0].actions == toset(["sns:Publish"]) &&
      data.aws_iam_policy_document.ses_events_topic.statement[0].resources == toset([aws_sns_topic.ses_events.arn]) &&
      toset(flatten([for p in data.aws_iam_policy_document.ses_events_topic.statement[0].principals : p.identifiers])) == toset(["ses.amazonaws.com"]) &&
      anytrue([for c in data.aws_iam_policy_document.ses_events_topic.statement[0].condition : c.variable == "aws:SourceArn" && c.values == tolist([aws_sesv2_configuration_set.main.arn])]) &&
      anytrue([for c in data.aws_iam_policy_document.ses_events_topic.statement[0].condition : c.variable == "aws:SourceAccount" && c.values == tolist(["000000000000"])])
    )
    error_message = "Only SES, for this configuration set in this account, may publish to the ses-events topic."
  }
  assert {
    condition     = aws_sns_topic_policy.ses_events.arn == aws_sns_topic.ses_events.arn
    error_message = "The ses-events topic carries its publish policy."
  }
  assert {
    condition = (
      length(data.aws_iam_policy_document.mail_events_queue.statement) == 1 &&
      data.aws_iam_policy_document.mail_events_queue.statement[0].actions == toset(["sqs:SendMessage"]) &&
      data.aws_iam_policy_document.mail_events_queue.statement[0].resources == toset([aws_sqs_queue.mail_events.arn]) &&
      toset(flatten([for p in data.aws_iam_policy_document.mail_events_queue.statement[0].principals : p.identifiers])) == toset(["sns.amazonaws.com"]) &&
      one(data.aws_iam_policy_document.mail_events_queue.statement[0].condition).variable == "aws:SourceArn" &&
      one(data.aws_iam_policy_document.mail_events_queue.statement[0].condition).values == tolist([aws_sns_topic.ses_events.arn])
    )
    error_message = "Only the ses-events topic may send to the mail-events queue."
  }
  assert {
    condition = (
      aws_sns_topic_subscription.mail_events.topic_arn == aws_sns_topic.ses_events.arn &&
      aws_sns_topic_subscription.mail_events.protocol == "sqs" &&
      aws_sns_topic_subscription.mail_events.endpoint == aws_sqs_queue.mail_events.arn &&
      aws_sns_topic_subscription.mail_events.raw_message_delivery
    )
    error_message = "The topic delivers raw SES events (no SNS envelope, mail/suppression.ts) to the mail-events queue."
  }

  # --- The queue: encrypted, a DLQ after 5 receives, visibility past the worker's timeout ---
  assert {
    condition     = aws_sqs_queue.mail_events.sqs_managed_sse_enabled && aws_sqs_queue.mail_events_dlq.sqs_managed_sse_enabled
    error_message = "Both mail-events queues must be encrypted (SSE-SQS): they hold addresses."
  }
  assert {
    condition = (
      jsondecode(aws_sqs_queue.mail_events.redrive_policy).maxReceiveCount == 5 &&
      jsondecode(aws_sqs_queue.mail_events.redrive_policy).deadLetterTargetArn == aws_sqs_queue.mail_events_dlq.arn &&
      aws_sqs_queue.mail_events.visibility_timeout_seconds >= 6 * aws_lambda_function.worker.timeout
    )
    error_message = "mail-events dead-letters after 5 receives, with visibility at least 6x the worker's timeout."
  }

  # --- The worker consumes it, and knows which queue is which ---------------------------
  assert {
    condition = (
      aws_lambda_event_source_mapping.worker_mail_events.event_source_arn == aws_sqs_queue.mail_events.arn &&
      aws_lambda_event_source_mapping.worker_mail_events.function_name == aws_lambda_function.worker.arn &&
      aws_lambda_function.worker.environment[0].variables["MAIL_EVENTS_QUEUE_ARN"] == aws_sqs_queue.mail_events.arn
    )
    error_message = "mail-events triggers the worker, which reads a record as an SES event only from that queue (MAIL_EVENTS_QUEUE_ARN)."
  }
  assert {
    condition = (
      aws_lambda_function.worker.environment[0].variables["JOBS_QUEUE_ARN"] == aws_sqs_queue.jobs.arn &&
      aws_lambda_function.worker.environment[0].variables["RENDER_RESULTS_QUEUE_ARN"] == aws_sqs_queue.render_results.arn &&
      aws_lambda_event_source_mapping.worker_render_results.event_source_arn == aws_sqs_queue.render_results.arn
    )
    error_message = "The worker reads a wake only from jobs and a render's answer only from render-results (lambda-worker.ts MESSAGE_QUEUES)."
  }
  assert {
    condition = (
      toset(flatten([for s in data.aws_iam_policy_document.worker_mail_events.statement : s.resources])) == toset([aws_sqs_queue.mail_events.arn]) &&
      alltrue([for s in data.aws_iam_policy_document.worker_mail_events.statement : alltrue([for a in s.actions : startswith(a, "sqs:") && !strcontains(a, "*") && a != "sqs:SendMessage"])]) &&
      aws_iam_role_policy.worker_mail_events.role == aws_iam_role.worker_lambda.id
    )
    error_message = "The worker may only receive from the mail-events queue (never send to it)."
  }
  assert {
    condition     = !contains(keys(aws_lambda_function.backend.environment[0].variables), "MAIL_EVENTS_QUEUE_ARN")
    error_message = "The API reads no SES events."
  }

  # --- Turning mail back on: the API may take an address off the suppression list ------
  assert {
    condition = (
      length(data.aws_iam_policy_document.lambda_ses_release.statement) == 1 &&
      data.aws_iam_policy_document.lambda_ses_release.statement[0].actions == toset(["ses:DeleteSuppressedDestination"]) &&
      aws_iam_role_policy.lambda_ses_release.role == aws_iam_role.lambda.id
    )
    error_message = "Only the API role may release a suppressed address, and only that action."
  }
  assert {
    condition     = !contains(flatten([for s in data.aws_iam_policy_document.lambda_ses.statement : tolist(s.actions)]), "ses:DeleteSuppressedDestination")
    error_message = "The shared send policy (the worker has it too) must not release suppressed addresses."
  }

  # --- Alarm ------------------------------------------------------------------------
  assert {
    condition = (
      one([for m in aws_cloudwatch_metric_alarm.mail_events_dlq_depth[0].metric_query : m.metric[0].dimensions["QueueName"] if m.id == "visible"]) == aws_sqs_queue.mail_events_dlq.name &&
      aws_cloudwatch_metric_alarm.mail_events_dlq_depth[0].threshold == 0 &&
      aws_cloudwatch_metric_alarm.mail_events_dlq_depth[0].alarm_actions == toset([aws_sns_topic.alerts.arn])
    )
    error_message = "A new message in the mail-events DLQ must alarm."
  }
}

# ---------------------------------------------------------------------------
# Data feeds (feeds.tf, WP-2.10)
# ---------------------------------------------------------------------------

run "data_feeds" {
  command = plan

  # --- Queues: SSE, a DLQ after 5 receives, visibility past the consumer's timeout ---
  assert {
    condition     = alltrue([for q in [aws_sqs_queue.fetch_requests[0], aws_sqs_queue.fetch_requests_dlq[0], aws_sqs_queue.ingest_results[0], aws_sqs_queue.ingest_results_dlq[0]] : q.sqs_managed_sse_enabled])
    error_message = "Every data-feed queue must be encrypted (SSE-SQS)."
  }
  assert {
    condition = (
      jsondecode(aws_sqs_queue.fetch_requests[0].redrive_policy).maxReceiveCount == 5 &&
      jsondecode(aws_sqs_queue.fetch_requests[0].redrive_policy).deadLetterTargetArn == aws_sqs_queue.fetch_requests_dlq[0].arn &&
      jsondecode(aws_sqs_queue.ingest_results[0].redrive_policy).maxReceiveCount == 5 &&
      jsondecode(aws_sqs_queue.ingest_results[0].redrive_policy).deadLetterTargetArn == aws_sqs_queue.ingest_results_dlq[0].arn
    )
    error_message = "Both data-feed queues must dead-letter to their own DLQ after 5 receives."
  }
  assert {
    condition = (
      aws_sqs_queue.fetch_requests[0].visibility_timeout_seconds >= 2 * aws_lambda_function.fetcher.timeout &&
      aws_sqs_queue.fetch_requests[0].visibility_timeout_seconds <= 3 * aws_lambda_function.fetcher.timeout &&
      aws_sqs_queue.ingest_results[0].visibility_timeout_seconds >= 6 * aws_lambda_function.worker.timeout
    )
    error_message = "Visibility must be at least 6x the consuming Lambda's timeout; fetch-requests (FIFO, no throttled receives) 2-3x, since an in-flight message holds its whole group."
  }

  # --- Politeness to CHC (issue #604): one fetch per source host at a time ----------
  assert {
    condition = (
      aws_sqs_queue.fetch_requests[0].fifo_queue == true &&
      aws_sqs_queue.fetch_requests_dlq[0].fifo_queue == true &&
      endswith(aws_sqs_queue.fetch_requests[0].name, ".fifo") &&
      endswith(aws_sqs_queue.fetch_requests_dlq[0].name, ".fifo") &&
      aws_sqs_queue.fetch_requests[0].content_based_deduplication == false
    )
    error_message = "fetch-requests (and its DLQ) must be FIFO: its message groups (one per source host) are what keep CHC to one fetch at a time across fetcher instances."
  }
  assert {
    condition = (
      aws_lambda_event_source_mapping.fetcher_requests[0].scaling_config[0].maximum_concurrency == 2 &&
      aws_lambda_function.fetcher.reserved_concurrent_executions >= aws_lambda_event_source_mapping.fetcher_requests[0].scaling_config[0].maximum_concurrency
    )
    error_message = "The fetcher's trigger: maximum_concurrency 2 (AWS's least; the message groups cap it per host), never above its reserved concurrency, or throttled receives burn the DLQ's 5."
  }
  assert {
    condition     = aws_lambda_function.fetcher.environment[0].variables["FEEDS_CONTACT"] == var.feeds_contact
    error_message = "The fetcher's user agent names the operator's contact (FEEDS_CONTACT = var.feeds_contact), which CHC asked for."
  }

  # --- The fetcher: outside the VPC, small, capped, live sources only --------------
  assert {
    condition = (
      aws_lambda_function.fetcher.runtime == "nodejs24.x" &&
      aws_lambda_function.fetcher.handler == "lambda-fetcher.handler" &&
      aws_lambda_function.fetcher.memory_size == 512 &&
      aws_lambda_function.fetcher.timeout == 900 &&
      aws_lambda_function.fetcher.reserved_concurrent_executions == 2
    )
    error_message = "Fetcher Lambda: nodejs24.x, lambda-fetcher.handler, 512 MB, 900 s, reserved concurrency 2."
  }
  assert {
    condition     = length(aws_lambda_function.fetcher.vpc_config) == 0
    error_message = "The fetcher runs outside the VPC: it is what keeps the feeds from needing a NAT."
  }
  assert {
    condition = (
      aws_lambda_function.fetcher.environment[0].variables["FEED_SOURCE"] == "live" &&
      aws_lambda_function.fetcher.environment[0].variables["INGEST_RESULTS_QUEUE_URL"] == aws_sqs_queue.ingest_results[0].url &&
      aws_lambda_function.fetcher.environment[0].variables["MIRROR_URL"] == "s3://${aws_s3_bucket.mirror.bucket}" &&
      aws_lambda_function.fetcher.environment[0].variables["STATION_API_FEEDS"] == "off" &&
      length(aws_lambda_function.fetcher.environment[0].variables) == 6
    )
    error_message = "The fetcher gets the live sources, the ingest-results queue, the mirror its daily ingest writes (issue #604 R2-B), the user agent's contact and station API feeds' switch and public key (off and empty by default, issue #784), and nothing else (no DATABASE_URL, no secrets)."
  }
  assert {
    condition = (
      toset(flatten([for s in data.aws_iam_policy_document.fetcher_lambda[0].statement : s.resources])) == toset([aws_sqs_queue.fetch_requests[0].arn, aws_sqs_queue.ingest_results[0].arn]) &&
      alltrue([for s in data.aws_iam_policy_document.fetcher_lambda[0].statement : s.sid != "SendIngestResults" || toset(s.actions) == toset(["sqs:SendMessage"])]) &&
      alltrue([for s in data.aws_iam_policy_document.fetcher_lambda[0].statement : alltrue([for a in s.actions : startswith(a, "sqs:") && !strcontains(a, "*")])])
    )
    error_message = "The fetcher's role reaches the two feed queues only: receive fetch-requests, send ingest-results."
  }
  assert {
    condition     = aws_iam_role_policy.lambda_logs["fetcher"].role == aws_iam_role.fetcher_lambda.id && !contains(keys(aws_iam_role_policy.lambda_vpc_eni), "fetcher")
    error_message = "The fetcher logs to its own log group only, with no VPC ENI policy (iam.tf; run lambda_logs_scoped in iam.tftest.hcl pins the statement)."
  }
  assert {
    condition = (
      aws_lambda_event_source_mapping.fetcher_requests[0].event_source_arn == aws_sqs_queue.fetch_requests[0].arn &&
      aws_lambda_event_source_mapping.fetcher_requests[0].function_name == aws_lambda_function.fetcher.arn &&
      aws_lambda_event_source_mapping.fetcher_requests[0].batch_size == 1 &&
      contains(aws_lambda_event_source_mapping.fetcher_requests[0].function_response_types, "ReportBatchItemFailures")
    )
    error_message = "fetch-requests triggers the fetcher, one request at a time, retrying only failed sends."
  }

  # --- The worker's side ------------------------------------------------------------
  assert {
    condition = (
      aws_lambda_function.worker.environment[0].variables["FEED_FETCHER"] == "sqs" &&
      aws_lambda_function.worker.environment[0].variables["FETCH_REQUESTS_QUEUE_URL"] == aws_sqs_queue.fetch_requests[0].url
    )
    error_message = "The worker hands fetches to the fetcher (it has no internet) and never fetches itself."
  }
  # FEED_SOURCE is also which CHIRPS cell cache a process reads (cellCacheStore.ts
  # cacheOrigin): the API and the worker run models from it, so both read the live
  # `chc` rows, never the fixtures' (unset on the API served runs no CHIRPS cells).
  assert {
    condition = (
      aws_lambda_function.backend.environment[0].variables["FEED_SOURCE"] == "live" &&
      aws_lambda_function.worker.environment[0].variables["FEED_SOURCE"] == "live"
    )
    error_message = "The API and the worker read the live CHIRPS cell cache (FEED_SOURCE = live), as the fetcher fills it."
  }
  assert {
    condition = (
      aws_lambda_event_source_mapping.worker_ingest_results[0].event_source_arn == aws_sqs_queue.ingest_results[0].arn &&
      aws_lambda_event_source_mapping.worker_ingest_results[0].function_name == aws_lambda_function.worker.arn
    )
    error_message = "ingest-results triggers the worker."
  }
  assert {
    condition     = toset(flatten([for s in data.aws_iam_policy_document.worker_feeds[0].statement : s.resources])) == toset([aws_sqs_queue.fetch_requests[0].arn, aws_sqs_queue.ingest_results[0].arn])
    error_message = "The worker's feed policy reaches the two feed queues only."
  }
  assert {
    condition     = toset(flatten([for s in data.aws_iam_policy_document.sqs_endpoint.statement : s.resources if contains(flatten([for p in s.principals : p.identifiers]), aws_iam_role.lambda.arn)])) == toset([aws_sqs_queue.jobs.arn])
    error_message = "Through the endpoint, the API reaches the jobs queue only, never the feed queues."
  }
  assert {
    condition     = contains(flatten([for s in data.aws_iam_policy_document.github_deploy.statement : s.resources if s.sid == "LambdaUpdate"]), aws_lambda_function.fetcher.arn)
    error_message = "The deploy role must be able to update the fetcher's code."
  }

  # --- Alarms -----------------------------------------------------------------------
  assert {
    condition = (
      one([for m in aws_cloudwatch_metric_alarm.fetch_requests_dlq_depth[0].metric_query : m.metric[0].dimensions["QueueName"] if m.id == "visible"]) == aws_sqs_queue.fetch_requests_dlq[0].name &&
      one([for m in aws_cloudwatch_metric_alarm.ingest_results_dlq_depth[0].metric_query : m.metric[0].dimensions["QueueName"] if m.id == "visible"]) == aws_sqs_queue.ingest_results_dlq[0].name &&
      aws_cloudwatch_metric_alarm.fetch_requests_dlq_depth[0].threshold == 0 &&
      aws_cloudwatch_metric_alarm.ingest_results_dlq_depth[0].threshold == 0
    )
    error_message = "A new message in either feed DLQ must alarm."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.fetcher_errors[0].dimensions["FunctionName"] == aws_lambda_function.fetcher.function_name
    error_message = "Fetcher errors must alarm."
  }
}

run "rejects_short_jobs_backlog_alarm" {
  command = plan

  variables {
    jobs_backlog_alarm_seconds = 300
  }

  expect_failures = [var.jobs_backlog_alarm_seconds]
}

# The request-flood alarm stays a cost control: above 20,000 per 5 minutes a
# flood just under it costs $9-16/day unseen; below 1,000 one person at the
# WAF's per-IP limit pages.
run "rejects_loose_cloudfront_requests_alarm" {
  command = plan

  variables {
    cloudfront_requests_alarm_per_5min = 20001
  }

  expect_failures = [var.cloudfront_requests_alarm_per_5min]
}

run "rejects_tight_cloudfront_requests_alarm" {
  command = plan

  variables {
    cloudfront_requests_alarm_per_5min = 999
  }

  expect_failures = [var.cloudfront_requests_alarm_per_5min]
}

# The failed-sign-in alarm: below 10 one person locking themselves out pages;
# above 300 one IP at the WAF's auth limit (100 per 5 minutes) stays unseen.
run "rejects_loose_login_failed_alarm" {
  command = plan

  variables {
    login_failed_alarm_per_15min = 301
  }

  expect_failures = [var.login_failed_alarm_per_15min]
}

run "rejects_tight_login_failed_alarm" {
  command = plan

  variables {
    login_failed_alarm_per_15min = 9
  }

  expect_failures = [var.login_failed_alarm_per_15min]
}

# ---------------------------------------------------------------------------
# Deploy role trust pin (bootstrap-owned; checked by the postcondition in
# oidc.tf so a drifted trust policy fails the plan)
# ---------------------------------------------------------------------------

run "deploy_trust_accepts_immutable_subject_claims" {
  command = plan

  override_data {
    target = data.aws_iam_role.github_deploy
    values = {
      arn                = "arn:aws:iam::000000000000:role/water-management-deploy"
      name               = "water-management-deploy"
      assume_role_policy = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sts:AssumeRoleWithWebIdentity\",\"Condition\":{\"StringEquals\":{\"token.actions.githubusercontent.com:aud\":\"sts.amazonaws.com\",\"token.actions.githubusercontent.com:sub\":\"repo:Absence0760@1234/project-water-management@5678:environment:production\"}}}]}"
    }
  }

  assert {
    condition     = aws_iam_role_policy_attachment.github_deploy.role == "water-management-deploy"
    error_message = "The deploy policy attaches to the bootstrap role."
  }
}

run "deploy_trust_rejects_branch_subject" {
  command = plan

  override_data {
    target = data.aws_iam_role.github_deploy
    values = {
      arn                = "arn:aws:iam::000000000000:role/water-management-deploy"
      name               = "water-management-deploy"
      assume_role_policy = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sts:AssumeRoleWithWebIdentity\",\"Condition\":{\"StringEquals\":{\"token.actions.githubusercontent.com:aud\":\"sts.amazonaws.com\",\"token.actions.githubusercontent.com:sub\":\"repo:Absence0760/project-water-management:ref:refs/heads/main\"}}}]}"
    }
  }

  expect_failures = [data.aws_iam_role.github_deploy]
}

run "deploy_trust_rejects_wildcard_subject" {
  command = plan

  override_data {
    target = data.aws_iam_role.github_deploy
    values = {
      arn                = "arn:aws:iam::000000000000:role/water-management-deploy"
      name               = "water-management-deploy"
      assume_role_policy = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sts:AssumeRoleWithWebIdentity\",\"Condition\":{\"StringEquals\":{\"token.actions.githubusercontent.com:aud\":\"sts.amazonaws.com\"},\"StringLike\":{\"token.actions.githubusercontent.com:sub\":\"repo:Absence0760/project-water-management:*\"}}}]}"
    }
  }

  expect_failures = [data.aws_iam_role.github_deploy]
}

run "deploy_trust_rejects_other_repo" {
  command = plan

  override_data {
    target = data.aws_iam_role.github_deploy
    values = {
      arn                = "arn:aws:iam::000000000000:role/water-management-deploy"
      name               = "water-management-deploy"
      assume_role_policy = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sts:AssumeRoleWithWebIdentity\",\"Condition\":{\"StringEquals\":{\"token.actions.githubusercontent.com:aud\":\"sts.amazonaws.com\",\"token.actions.githubusercontent.com:sub\":\"repo:someone-else/project-water-management:environment:production\"}}}]}"
    }
  }

  expect_failures = [data.aws_iam_role.github_deploy]
}

run "deploy_policy_has_no_wildcards" {
  command = plan

  assert {
    condition = alltrue(flatten([for s in data.aws_iam_policy_document.github_deploy.statement : [
      for a in s.actions : !strcontains(a, "*")
    ]]))
    error_message = "Deploy policy actions must be named, never wildcards."
  }
  assert {
    condition = alltrue(flatten([for s in data.aws_iam_policy_document.github_deploy.statement : [
      for r in s.resources : r != "*" if s.sid != "EcrLogin"
    ]]))
    error_message = "Deploy policy resources must be specific ARNs."
  }
  # The one exception: ECR's docker login has no resource-level permissions
  # (AWS), so that statement is "*", with that one action and nothing else.
  assert {
    condition = alltrue([for s in data.aws_iam_policy_document.github_deploy.statement :
      s.sid != "EcrLogin" || (toset(s.actions) == toset(["ecr:GetAuthorizationToken"]) && toset(s.resources) == toset(["*"]))
    ])
    error_message = "EcrLogin may hold ecr:GetAuthorizationToken only."
  }
  assert {
    condition = alltrue([for s in data.aws_iam_policy_document.github_deploy.statement :
      s.sid != "RendererImagePush" || toset(s.resources) == toset([aws_ecr_repository.renderer.arn])
    ])
    error_message = "The deploy role pushes to the renderer's repository only."
  }
}
