# Plan-only guardrail tests against mocked providers: no AWS credentials, no
# state, no sops key (the runtime secrets are ephemeral variables, set to
# synthetic values below). They pin the production guardrails that
# `terraform validate` can't see. This file: the Lambda concurrency caps, the WAF rate rules, the sign-in CAPTCHA, and
# the private-only network (no gateway or default route, the exact
# security-group graph, the Function URL's auth type, every security group's
# description).
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
# Lambda concurrency caps: never unreserved (-1), and the worker's cap covers
# every SQS trigger it has
# ---------------------------------------------------------------------------

run "rejects_unreserved_api_concurrency" {
  command = plan

  variables {
    lambda_reserved_concurrency = -1
  }

  expect_failures = [var.lambda_reserved_concurrency]
}

# Issue #541: the cap x pool sums must fit the database on every tfvars, not
# only at the defaults (the precondition on aws_lambda_function.backend). 30 x 2
# + 8 x 2 + 2 = 78 > 70; 26 is the most at the default worker cap (26 x 2 + 16
# + 2 = 70), and a worker cap of 12 is past it too (50 + 24 + 2 = 76).
run "rejects_api_concurrency_past_the_database_connections" {
  command = plan

  variables {
    lambda_reserved_concurrency = 30
  }

  expect_failures = [aws_lambda_function.backend]
}

run "rejects_worker_concurrency_past_the_database_connections" {
  command = plan

  variables {
    worker_reserved_concurrency = 12
  }

  expect_failures = [aws_lambda_function.backend]
}

run "accepts_api_concurrency_at_the_database_connections" {
  command = plan

  variables {
    lambda_reserved_concurrency = 26
  }

  assert {
    condition     = aws_lambda_function.backend.reserved_concurrent_executions == 26
    error_message = "26 x 2 + 8 x 2 + 2 = 70 connections is within the precondition (positive control)."
  }
}

run "rejects_unreserved_migrate_concurrency" {
  command = plan

  variables {
    migrate_reserved_concurrency = -1
  }

  expect_failures = [var.migrate_reserved_concurrency]
}

run "rejects_unreserved_worker_concurrency" {
  command = plan

  variables {
    worker_reserved_concurrency = -1
  }

  expect_failures = [var.worker_reserved_concurrency]
}

run "rejects_unreserved_fetcher_concurrency" {
  command = plan

  variables {
    fetcher_reserved_concurrency = -1
  }

  expect_failures = [var.fetcher_reserved_concurrency]
}

# feeds_contact is required (no default) and must be an address someone reads:
# the fetcher refuses to start without one (backend/src/config/production.ts).
run "rejects_empty_feeds_contact" {
  command = plan
  variables {
    feeds_contact = ""
  }
  expect_failures = [var.feeds_contact]
}

run "rejects_malformed_feeds_contact" {
  command = plan
  variables {
    feeds_contact = "ops at icwbt.jaredhoward.com"
  }
  expect_failures = [var.feeds_contact]
}

run "rejects_reserved_feeds_contact" {
  command = plan
  variables {
    feeds_contact = "ops@feeds.example.org"
  }
  expect_failures = [var.feeds_contact]
}

run "rejects_template_feeds_contact" {
  command = plan
  variables {
    feeds_contact = "you@icwbt.jaredhoward.com"
  }
  expect_failures = [var.feeds_contact]
}

run "rejects_header_breaking_feeds_contact" {
  command = plan
  variables {
    feeds_contact = "ops@icwbt.jaredhoward.com) evil"
  }
  expect_failures = [var.feeds_contact]
}

run "rejects_unreserved_renderer_concurrency" {
  command = plan

  variables {
    renderer_reserved_concurrency = -1
  }

  expect_failures = [var.renderer_reserved_concurrency]
}

run "rejects_worker_concurrency_below_its_triggers" {
  command = plan

  variables {
    worker_reserved_concurrency = 2
  }

  expect_failures = [var.worker_reserved_concurrency]
}

run "worker_sqs_triggers" {
  command = plan

  # Enables the renderer too, so every SQS trigger in the stack is planned.
  variables {
    renderer_image_tag = "0.4.0-0123456789ab"
  }

  assert {
    condition = aws_lambda_function.worker.reserved_concurrent_executions >= sum([
      for m in [
        aws_lambda_event_source_mapping.worker_jobs,
        aws_lambda_event_source_mapping.worker_ingest_results[0],
        aws_lambda_event_source_mapping.worker_render_results,
        aws_lambda_event_source_mapping.worker_mail_events,
      ] : m.scaling_config[0].maximum_concurrency
    ])
    error_message = "The worker's reserved concurrency must cover the sum of its SQS triggers' maximum_concurrency, or throttled messages burn receive counts into the DLQs."
  }
  assert {
    condition = (
      aws_lambda_function.fetcher.reserved_concurrent_executions >= aws_lambda_event_source_mapping.fetcher_requests[0].scaling_config[0].maximum_concurrency &&
      aws_lambda_function.renderer[0].reserved_concurrent_executions >= aws_lambda_event_source_mapping.renderer_requests[0].scaling_config[0].maximum_concurrency
    )
    error_message = "The fetcher's and renderer's reserved concurrency must cover their SQS trigger's maximum_concurrency."
  }
  assert {
    condition = alltrue([
      for m in [
        aws_lambda_event_source_mapping.worker_jobs,
        aws_lambda_event_source_mapping.worker_ingest_results[0],
        aws_lambda_event_source_mapping.worker_render_results,
        aws_lambda_event_source_mapping.worker_mail_events,
      ] : m.function_name == aws_lambda_function.worker.arn && try(contains(m.function_response_types, "ReportBatchItemFailures"), false)
    ])
    error_message = "Every worker SQS trigger must honour partial batch failures (ReportBatchItemFailures), so one bad record doesn't dead-letter its batch."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.worker_throttles[0].metric_name == "Throttles" &&
      aws_cloudwatch_metric_alarm.worker_throttles[0].dimensions["FunctionName"] == aws_lambda_function.worker.function_name &&
      aws_cloudwatch_metric_alarm.worker_throttles[0].threshold == 0
    )
    error_message = "Any worker throttle must alarm."
  }
}

# ---------------------------------------------------------------------------
# WAF: the auth rate limit matches the decoded, normalised path
# ---------------------------------------------------------------------------

run "waf_auth_rule_matches_decoded_path" {
  command = plan

  assert {
    condition = [
      for t in one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitAuthPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].byte_match_statement[0].text_transformation :
      t.type if t.priority == 0
    ] == ["URL_DECODE"]
    error_message = "The auth rate limit must URL-decode the path first, or /api/%61uth/login slips past it."
  }
  assert {
    condition = toset([
      for t in one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitAuthPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].byte_match_statement[0].text_transformation :
      "${t.priority}:${t.type}"
    ]) == toset(["0:URL_DECODE", "1:NORMALIZE_PATH", "2:LOWERCASE"])
    error_message = "The auth rate limit's path transformations must be URL_DECODE, then NORMALIZE_PATH, then LOWERCASE."
  }
}

# The API's per-IP limit counts /api/* only, so the SPA's files (a cold visit
# is ~150 requests; the report renderer loads them for every PDF) don't eat
# it; the site-wide backstop still caps one IP on every path (waf.tf).
run "waf_rate_rules_scope" {
  command = plan

  assert {
    condition = (
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitPerIP"]).statement[0].rate_based_statement[0].limit == 1000 &&
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitPerIP"]).statement[0].rate_based_statement[0].aggregate_key_type == "IP" &&
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].byte_match_statement[0].search_string == "/api/" &&
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].byte_match_statement[0].positional_constraint == "STARTS_WITH" &&
      length(one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].byte_match_statement[0].field_to_match[0].uri_path) == 1
    )
    error_message = "The API rate rule must count only paths starting /api/ (the URI path), per IP, at waf_rate_limit_per_ip."
  }
  assert {
    condition = toset([
      for t in one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].byte_match_statement[0].text_transformation :
      "${t.priority}:${t.type}"
    ]) == toset(["0:URL_DECODE", "1:NORMALIZE_PATH", "2:LOWERCASE"])
    error_message = "The API rate rule must match the path as the API routes it (URL_DECODE, NORMALIZE_PATH, LOWERCASE), or /%61pi/… slips past it."
  }
  assert {
    condition = (
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitSitePerIP"]).statement[0].rate_based_statement[0].limit == 5000 &&
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitSitePerIP"]).statement[0].rate_based_statement[0].aggregate_key_type == "IP" &&
      length(one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitSitePerIP"]).statement[0].rate_based_statement[0].scope_down_statement) == 0 &&
      length(one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitSitePerIP"]).action[0].block) == 1
    )
    error_message = "The site-wide backstop must block per IP on every path (no scope-down) at waf_site_rate_limit_per_ip."
  }
  assert {
    condition = (
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitAuthPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].byte_match_statement[0].search_string == "/api/auth/" &&
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitAuthPerIP"]).statement[0].rate_based_statement[0].limit == 100
    )
    error_message = "The auth rate rule stays /api/auth/ at 100 per 5 minutes."
  }
  assert {
    condition     = { for r in aws_wafv2_web_acl.frontend.rule : r.name => r.priority } == { RateLimitAuthPerIP = 0, SignInCaptchaPerIP = 1, RateLimitDemPerIP = 2, RateLimitPerIP = 3, RateLimitTilesPerIP = 4, RateLimitSitePerIP = 5 }
    error_message = "The rate rules run tightest first: auth, the elevation-model routes, API, the tiles, then the site-wide backstop."
  }
  # The tiles' bytes bound (waf.tf): /tiles/ only, per IP, blocking, the path as CloudFront matches it.
  assert {
    condition = (
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitTilesPerIP"]).statement[0].rate_based_statement[0].limit == 1000 &&
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitTilesPerIP"]).statement[0].rate_based_statement[0].aggregate_key_type == "IP" &&
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitTilesPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].byte_match_statement[0].search_string == "/tiles/" &&
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitTilesPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].byte_match_statement[0].positional_constraint == "STARTS_WITH" &&
      length(one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitTilesPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].byte_match_statement[0].field_to_match[0].uri_path) == 1 &&
      length(one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitTilesPerIP"]).action[0].block) == 1
    )
    error_message = "The tiles rate rule must block per IP on paths starting /tiles/ at waf_tiles_rate_limit_per_ip (the egress bound: each request may be 2 MiB)."
  }
  assert {
    condition = toset([
      for t in one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitTilesPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].byte_match_statement[0].text_transformation :
      "${t.priority}:${t.type}"
    ]) == toset(["0:URL_DECODE", "1:NORMALIZE_PATH", "2:LOWERCASE"])
    error_message = "The tiles rate rule must match the decoded, normalised, lowercased path, or /%74iles/… slips past it."
  }
}

# The elevation-model routes (waf.tf RateLimitDemPerIP): a lower limit than
# the API's on the collection paths that read DEM or water tiles, matched on
# the path as the API routes it. regex() here is Terraform's RE2; the WAF's
# regex is PCRE, and this pattern uses only what both read alike (anchors,
# a negated class, alternation).
run "waf_dem_rule" {
  command = plan

  assert {
    condition = (
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitDemPerIP"]).statement[0].rate_based_statement[0].limit == 300 &&
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitDemPerIP"]).statement[0].rate_based_statement[0].limit < one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitPerIP"]).statement[0].rate_based_statement[0].limit &&
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitDemPerIP"]).statement[0].rate_based_statement[0].aggregate_key_type == "IP" &&
      length(one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitDemPerIP"]).action[0].block) == 1 &&
      length(one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitDemPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].regex_match_statement[0].field_to_match[0].uri_path) == 1
    )
    error_message = "The elevation-model rule must block per IP at waf_dem_rate_limit_per_ip (300), below the API's limit, on the URI path."
  }
  assert {
    condition = toset([
      for t in one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitDemPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].regex_match_statement[0].text_transformation :
      "${t.priority}:${t.type}"
    ]) == toset(["0:URL_DECODE", "1:NORMALIZE_PATH", "2:LOWERCASE"])
    error_message = "The elevation-model rule must match the decoded, normalised, lowercased path, or /api/projects/x/map/%64em-grid slips past it."
  }
  # Every route that reads the DEM or the water raster matches...
  assert {
    condition = alltrue([for path in [
      "/api/projects/0b7c4f8e-1d2a-4c3b-9e8f-123456789abc/map/delineation",
      "/api/projects/0b7c4f8e-1d2a-4c3b-9e8f-123456789abc/map/delineation/",
      "/api/projects/p/map/start",
      "/api/projects/p/map/divide",
      "/api/projects/p/map/subcatchments",
      "/api/projects/p/map/subcatchments/save",
      "/api/projects/p/map/channels",
      "/api/projects/p/map/dem-grid",
      "/api/projects/p/map/dam-trace",
    ] : can(regex(one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitDemPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].regex_match_statement[0].regex_string, path))])
    error_message = "The elevation-model rule must match every route that reads the DEM or the water raster (waf.tf local.waf_dem_routes)."
  }
  # ...and nothing else: the polls, accept/reject/apply/discard, the rest of the Map.
  assert {
    condition = !anytrue([for path in [
      "/api/projects/p/map/delineation/requests/r1",
      "/api/projects/p/map/delineation/p1/accept",
      "/api/projects/p/map/delineation/p1/reject",
      "/api/projects/p/map/start/requests/r1",
      "/api/projects/p/map/start/s1/apply",
      "/api/projects/p/map/start/s1/discard",
      "/api/projects/p/map/divide/s1/apply",
      "/api/projects/p/map/features",
      "/api/projects/p/map/dem-gridx",
      "/api/projects/p/map/startx",
      "/api/projects/p/map",
      "/api/projects/p/model",
      "/tiles/terrain.pmtiles",
      "/api/projects/p/q/map/start",
    ] : can(regex(one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitDemPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].regex_match_statement[0].regex_string, path))])
    error_message = "The elevation-model rule must match only the collection paths that read tiles, not the polls, the decisions or the rest of the API."
  }
}

run "rejects_dem_rate_limit_above_the_api_limit" {
  command = plan

  variables {
    waf_dem_rate_limit_per_ip = 1001
  }

  expect_failures = [var.waf_dem_rate_limit_per_ip]
}

run "rejects_dem_rate_limit_below_the_aws_minimum" {
  command = plan

  variables {
    waf_dem_rate_limit_per_ip = 99
  }

  expect_failures = [var.waf_dem_rate_limit_per_ip]
}

run "rejects_tiles_rate_limit_above_the_site_limit" {
  command = plan

  variables {
    waf_tiles_rate_limit_per_ip = 5001
  }

  expect_failures = [var.waf_tiles_rate_limit_per_ip]
}

run "rejects_bytes_alarm_too_high" {
  command = plan

  variables {
    cloudfront_bytes_alarm_gb_per_5min = 5
  }

  expect_failures = [var.cloudfront_bytes_alarm_gb_per_5min]
}

run "rejects_site_rate_limit_below_the_api_limit" {
  command = plan

  variables {
    waf_rate_limit_per_ip      = 2000
    waf_site_rate_limit_per_ip = 1999
  }

  expect_failures = [var.waf_site_rate_limit_per_ip]
}

# ---------------------------------------------------------------------------
# The sign-in CAPTCHA (waf.tf SignInCaptchaPerIP, issue #126): only sign-in
# POSTs, only past a per-IP rate below the auth block, a 5-minute immunity,
# COUNT as the switch-off; the API key for the site's domain; and a CSP that
# allows exactly the account's two SDK origins once they are known.
# ---------------------------------------------------------------------------

run "signin_captcha" {
  command = plan

  assert {
    condition     = toset([for r in aws_wafv2_web_acl.frontend.rule : "${r.priority}:${r.name}"]) == toset(["0:RateLimitAuthPerIP", "1:SignInCaptchaPerIP", "2:RateLimitDemPerIP", "3:RateLimitPerIP", "4:RateLimitTilesPerIP", "5:RateLimitSitePerIP"])
    error_message = "Rule order: the auth block first (an IP past 100 is blocked, not offered a billed puzzle), then the sign-in CAPTCHA, then the site-wide limit."
  }
  assert {
    condition = (
      length(one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "SignInCaptchaPerIP"]).action[0].captcha) == 1 &&
      length(one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "SignInCaptchaPerIP"]).action[0].count) == 0 &&
      length(one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "SignInCaptchaPerIP"]).action[0].block) == 0
    )
    error_message = "By default the sign-in rule's action is CAPTCHA, never a block."
  }
  assert {
    condition     = one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "SignInCaptchaPerIP"]).captcha_config[0].immunity_time_property[0].immunity_time == 300
    error_message = "A solved puzzle lasts 5 minutes (captcha_config immunity_time = 300)."
  }
  assert {
    condition = (
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "SignInCaptchaPerIP"]).statement[0].rate_based_statement[0].limit == 20 &&
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "SignInCaptchaPerIP"]).statement[0].rate_based_statement[0].evaluation_window_sec == 300 &&
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "SignInCaptchaPerIP"]).statement[0].rate_based_statement[0].aggregate_key_type == "IP" &&
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "SignInCaptchaPerIP"]).statement[0].rate_based_statement[0].limit < one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitAuthPerIP"]).statement[0].rate_based_statement[0].limit
    )
    error_message = "The puzzle starts past 20 sign-ins per IP in 5 minutes, below the auth block's limit."
  }
  # Scope: POST and exactly /api/auth/login (decoded, normalised, lower-cased).
  assert {
    condition = (
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "SignInCaptchaPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].and_statement[0].statement[0].byte_match_statement[0].search_string == "POST" &&
      length(one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "SignInCaptchaPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].and_statement[0].statement[0].byte_match_statement[0].field_to_match[0].method) == 1 &&
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "SignInCaptchaPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].and_statement[0].statement[0].byte_match_statement[0].positional_constraint == "EXACTLY"
    )
    error_message = "The sign-in CAPTCHA applies to POST only."
  }
  assert {
    condition = (
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "SignInCaptchaPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].and_statement[0].statement[1].byte_match_statement[0].search_string == "/api/auth/login" &&
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "SignInCaptchaPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].and_statement[0].statement[1].byte_match_statement[0].positional_constraint == "EXACTLY" &&
      length(one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "SignInCaptchaPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].and_statement[0].statement[1].byte_match_statement[0].field_to_match[0].uri_path) == 1 &&
      toset([for t in one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "SignInCaptchaPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].and_statement[0].statement[1].byte_match_statement[0].text_transformation : "${t.priority}:${t.type}"]) == toset(["0:URL_DECODE", "1:NORMALIZE_PATH", "2:LOWERCASE"])
    )
    error_message = "The sign-in CAPTCHA matches exactly the path /api/auth/login, after URL_DECODE, NORMALIZE_PATH and LOWERCASE."
  }
  assert {
    condition = (
      aws_wafv2_api_key.captcha.scope == "CLOUDFRONT" &&
      aws_wafv2_api_key.captcha.token_domains == toset([var.domain_name])
    )
    error_message = "The CAPTCHA API key is CloudFront-scoped and valid for the site's domain only."
  }
  # No integration URL yet: no WAF origin in the CSP, and no script URL for the build.
  assert {
    condition = (
      !strcontains(aws_cloudfront_response_headers_policy.site.security_headers_config[0].content_security_policy[0].content_security_policy, "awswaf") &&
      strcontains(aws_cloudfront_response_headers_policy.site.security_headers_config[0].content_security_policy[0].content_security_policy, "media-src 'self' data:") &&
      output.waf_captcha_script_url == ""
    )
    error_message = "Without waf_captcha_integration_url the CSP names no WAF origin (media-src allows data: for the puzzle's audio) and the build gets no script URL."
  }
}

run "signin_captcha_with_integration_url" {
  command = plan

  variables {
    waf_captcha_integration_url = "https://a1b2c3d4e5f6.edge.captcha-sdk.awswaf.com/a1b2c3d4e5f6/"
  }

  assert {
    condition     = strcontains(aws_cloudfront_response_headers_policy.site.security_headers_config[0].content_security_policy[0].content_security_policy, "script-src 'self' 'unsafe-inline' https://a1b2c3d4e5f6.edge.captcha-sdk.awswaf.com https://a1b2c3d4e5f6.edge.sdk.awswaf.com;")
    error_message = "script-src allows exactly the CAPTCHA SDK origin and its challenge script's."
  }
  assert {
    condition     = strcontains(aws_cloudfront_response_headers_policy.site.security_headers_config[0].content_security_policy[0].content_security_policy, "connect-src 'self' https://a1b2c3d4e5f6.edge.captcha-sdk.awswaf.com https://a1b2c3d4e5f6.edge.sdk.awswaf.com;")
    error_message = "connect-src allows exactly the same two origins (the puzzle, verify and telemetry calls)."
  }
  assert {
    condition = (
      !strcontains(aws_cloudfront_response_headers_policy.site.security_headers_config[0].content_security_policy[0].content_security_policy, "*") &&
      !strcontains(aws_cloudfront_response_headers_policy.site.security_headers_config[0].content_security_policy[0].content_security_policy, "unsafe-eval") &&
      !strcontains(aws_cloudfront_response_headers_policy.site.security_headers_config[0].content_security_policy[0].content_security_policy, "blob:") &&
      length(regexall("https://", aws_cloudfront_response_headers_policy.site.security_headers_config[0].content_security_policy[0].content_security_policy)) == 4
    )
    error_message = "The CAPTCHA adds exactly two origins to two directives: no wildcard, no unsafe-eval, no blob:."
  }
  assert {
    condition     = output.waf_captcha_script_url == "https://a1b2c3d4e5f6.edge.captcha-sdk.awswaf.com/a1b2c3d4e5f6/jsapi.js"
    error_message = "The build's script URL is the integration URL's jsapi.js."
  }
}

run "signin_captcha_count_mode" {
  command = plan

  variables {
    waf_signin_captcha_action = "COUNT"
  }

  assert {
    condition = (
      length(one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "SignInCaptchaPerIP"]).action[0].count) == 1 &&
      length(one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "SignInCaptchaPerIP"]).action[0].captcha) == 0
    )
    error_message = "COUNT switches the puzzle off and keeps the rule counting."
  }
}

run "rejects_signin_captcha_at_the_block_limit" {
  command = plan
  variables {
    waf_signin_captcha_per_5min = 100
  }
  expect_failures = [var.waf_signin_captcha_per_5min]
}

run "rejects_signin_captcha_below_aws_minimum" {
  command = plan
  variables {
    waf_signin_captcha_per_5min = 9
  }
  expect_failures = [var.waf_signin_captcha_per_5min]
}

run "rejects_unknown_signin_captcha_action" {
  command = plan
  variables {
    waf_signin_captcha_action = "BLOCK"
  }
  expect_failures = [var.waf_signin_captcha_action]
}

run "rejects_a_wildcard_captcha_integration_url" {
  command = plan
  variables {
    waf_captcha_integration_url = "https://*.awswaf.com/"
  }
  expect_failures = [var.waf_captcha_integration_url]
}

# ---------------------------------------------------------------------------
# Network: the private-only VPC and the security-group graph (network.tf)
# ---------------------------------------------------------------------------
#
# Terraform tests can't enumerate "every resource of a type", so the
# whole-module invariants (no gateway or default route anywhere, the complete
# set of security-group rules) read the source, like the parameter group's
# lifecycle check in production_guardrails; the plan-time asserts pin the
# same edges by resolved ID. `terraform test` refuses an assert that names no
# configuration object, so each source-reading one is anchored to the VPC it
# describes with `aws_vpc.main.cidr_block != ""`.

run "network" {
  command = plan

  # --- No way out: no gateway, no default route, no public addresses -------
  assert {
    condition = aws_vpc.main.cidr_block != "" && alltrue([
      for f in fileset(".", "*.tf") :
      length(regexall("resource \"aws_(internet_gateway|egress_only_internet_gateway|nat_gateway|eip|route|vpn_gateway|vpc_peering_connection|ec2_transit_gateway_vpc_attachment)\"", file(f))) == 0
    ])
    error_message = "The VPC is private-only: no internet, egress-only or NAT gateway, Elastic IP, aws_route, VPN, peering or transit attachment. External hosts are reached by a Lambda outside the VPC (feeds.tf), AWS APIs through interface endpoints."
  }
  assert {
    condition = aws_vpc.main.cidr_block != "" && alltrue([
      for f in fileset(".", "*.tf") :
      length(regexall("\"(0\\.0\\.0\\.0/0|::/0)\"", file(f))) == 0
    ])
    error_message = "No 0.0.0.0/0 or ::/0 anywhere in the module: not as a route, not in a security-group rule."
  }
  assert {
    condition     = aws_vpc.main.cidr_block != "" && length(regexall("\\broute\\s*\\{", regex("(?s)resource \"aws_route_table\" \"private\" \\{.*?\\n\\}", file("network.tf")))) == 0
    error_message = "The private route table holds only the implicit local route (no inline route blocks)."
  }
  assert {
    condition     = length(aws_route_table_association.private) == 2 && alltrue([for a in aws_route_table_association.private : a.route_table_id == aws_route_table.private.id])
    error_message = "Both private subnets must be explicitly associated with the route-less private route table."
  }
  assert {
    condition     = alltrue([for s in aws_subnet.private : s.map_public_ip_on_launch != true])
    error_message = "The private subnets never hand out public IPs (map_public_ip_on_launch unset or false)."
  }

  # --- Security-group rules: SG to SG only, the exact graph ------------------
  # Every rule references another security group (no CIDR, no prefix list),
  # rules are standalone resources (no aws_security_group_rule, no inline
  # blocks), and the full set of edges is exactly this.
  assert {
    condition = aws_vpc.main.cidr_block != "" && alltrue([
      for f in fileset(".", "*.tf") :
      length(regexall("\\b(cidr_ipv4|cidr_ipv6|cidr_blocks|ipv6_cidr_blocks|prefix_list_id|prefix_list_ids)\\s*=", file(f))) == 0
      && length(regexall("resource \"aws_security_group_rule\"", file(f))) == 0
      && length(regexall("(?m)^\\s*(ingress|egress)\\s*\\{", file(f))) == 0
    ])
    error_message = "Security-group rules reference security groups only (no CIDR or prefix list) and are aws_vpc_security_group_{ingress,egress}_rule resources, never inline blocks or aws_security_group_rule."
  }
  assert {
    condition = aws_vpc.main.cidr_block != "" && toset(flatten([
      for f in fileset(".", "*.tf") : [
        for b in regexall("(?s)resource \"aws_vpc_security_group_ingress_rule\" \"[A-Za-z0-9_-]+\" \\{.*?\\n\\}", file(f)) :
        format("%s <- %s %s/%s-%s",
          try(regex("\\n\\s*security_group_id\\s*=\\s*aws_security_group\\.([A-Za-z0-9_-]+)(?:\\[0\\])?\\.id", b)[0], "?"),
          try(regex("\\n\\s*referenced_security_group_id\\s*=\\s*aws_security_group\\.([A-Za-z0-9_-]+)(?:\\[0\\])?\\.id", b)[0], "NOT-A-SECURITY-GROUP"),
          try(regex("\\n\\s*ip_protocol\\s*=\\s*\"([^\"]+)\"", b)[0], "?"),
          try(regex("\\n\\s*from_port\\s*=\\s*([0-9]+)", b)[0], "?"),
          try(regex("\\n\\s*to_port\\s*=\\s*([0-9]+)", b)[0], "?"),
        )
      ]
      ])) == toset([
      "rds <- api_lambda tcp/5432-5432",
      "rds <- migrate_lambda tcp/5432-5432",
      "rds <- worker_lambda tcp/5432-5432",
      "vpce <- api_lambda tcp/443-443",
      "vpce <- migrate_lambda tcp/443-443",
      "vpce <- worker_lambda tcp/443-443",
      "vpce_sqs <- api_lambda tcp/443-443",
      "vpce_sqs <- worker_lambda tcp/443-443",
      "vpce_ses <- api_lambda tcp/443-443",
      "vpce_ses <- worker_lambda tcp/443-443",
      "vpce_s3 <- worker_lambda tcp/443-443",
      "vpce_s3 <- api_lambda tcp/443-443",
      "vpce_s3 <- migrate_lambda tcp/443-443",
      # The assistant (assistant.tf), only with assistant_enabled; pinned on in assistant.tftest.hcl.
      "rds <- assistant_lambda tcp/5432-5432",
      "vpce <- assistant_lambda tcp/443-443",
      "bedrock_vpce <- assistant_lambda tcp/443-443",
    ])
    error_message = "Ingress rules must be exactly: Postgres from the API, migrate and worker Lambdas; Secrets Manager endpoint from migrate; SQS and SES endpoints from the API and worker; the S3 endpoint from the worker (pack PDF checks, packs.tf), the API and migrate (reference loads, map_data.tf); with assistant_enabled, Postgres, the Secrets Manager endpoint and the Bedrock endpoint from the assistant (assistant.tf). A new edge is a deliberate change to this list."
  }
  assert {
    condition = aws_vpc.main.cidr_block != "" && toset(flatten([
      for f in fileset(".", "*.tf") : [
        for b in regexall("(?s)resource \"aws_vpc_security_group_egress_rule\" \"[A-Za-z0-9_-]+\" \\{.*?\\n\\}", file(f)) :
        format("%s -> %s %s/%s-%s",
          try(regex("\\n\\s*security_group_id\\s*=\\s*aws_security_group\\.([A-Za-z0-9_-]+)(?:\\[0\\])?\\.id", b)[0], "?"),
          try(regex("\\n\\s*referenced_security_group_id\\s*=\\s*aws_security_group\\.([A-Za-z0-9_-]+)(?:\\[0\\])?\\.id", b)[0], "NOT-A-SECURITY-GROUP"),
          try(regex("\\n\\s*ip_protocol\\s*=\\s*\"([^\"]+)\"", b)[0], "?"),
          try(regex("\\n\\s*from_port\\s*=\\s*([0-9]+)", b)[0], "?"),
          try(regex("\\n\\s*to_port\\s*=\\s*([0-9]+)", b)[0], "?"),
        )
      ]
      ])) == toset([
      "api_lambda -> rds tcp/5432-5432",
      "api_lambda -> vpce_sqs tcp/443-443",
      "api_lambda -> vpce_ses tcp/443-443",
      "api_lambda -> vpce tcp/443-443",
      "migrate_lambda -> rds tcp/5432-5432",
      "migrate_lambda -> vpce tcp/443-443",
      "worker_lambda -> rds tcp/5432-5432",
      "worker_lambda -> vpce_sqs tcp/443-443",
      "worker_lambda -> vpce_ses tcp/443-443",
      "worker_lambda -> vpce tcp/443-443",
      "worker_lambda -> vpce_s3 tcp/443-443",
      "api_lambda -> vpce_s3 tcp/443-443",
      "migrate_lambda -> vpce_s3 tcp/443-443",
      "assistant_lambda -> rds tcp/5432-5432",
      "assistant_lambda -> vpce tcp/443-443",
      "assistant_lambda -> bedrock_vpce tcp/443-443",
    ])
    error_message = "Egress rules must be exactly the Lambdas' paths to Postgres and their endpoints; RDS and the endpoints have no egress."
  }

  # --- The database: only the three in-VPC Lambdas reach it ---------------
  assert {
    condition     = aws_db_instance.main.vpc_security_group_ids == toset([aws_security_group.rds.id]) && !aws_db_instance.main.publicly_accessible
    error_message = "RDS sits in its own security group only, and is not publicly accessible."
  }
  assert {
    condition = (
      aws_vpc_security_group_ingress_rule.rds_from_api.security_group_id == aws_security_group.rds.id &&
      aws_vpc_security_group_ingress_rule.rds_from_api.referenced_security_group_id == aws_security_group.api_lambda.id &&
      aws_vpc_security_group_ingress_rule.rds_from_migrate.security_group_id == aws_security_group.rds.id &&
      aws_vpc_security_group_ingress_rule.rds_from_migrate.referenced_security_group_id == aws_security_group.migrate_lambda.id &&
      aws_vpc_security_group_ingress_rule.rds_from_worker.security_group_id == aws_security_group.rds.id &&
      aws_vpc_security_group_ingress_rule.rds_from_worker.referenced_security_group_id == aws_security_group.worker_lambda.id &&
      alltrue([for r in [aws_vpc_security_group_ingress_rule.rds_from_api, aws_vpc_security_group_ingress_rule.rds_from_migrate, aws_vpc_security_group_ingress_rule.rds_from_worker] : r.ip_protocol == "tcp" && r.from_port == 5432 && r.to_port == 5432 && r.cidr_ipv4 == null && r.cidr_ipv6 == null])
    )
    error_message = "Postgres (5432/tcp) is reachable from the API, migrate and worker Lambda security groups only."
  }
  assert {
    condition = (
      aws_lambda_function.backend.vpc_config[0].security_group_ids == toset([aws_security_group.api_lambda.id]) &&
      aws_lambda_function.migrate.vpc_config[0].security_group_ids == toset([aws_security_group.migrate_lambda.id]) &&
      aws_lambda_function.worker.vpc_config[0].security_group_ids == toset([aws_security_group.worker_lambda.id]) &&
      length(aws_lambda_function.fetcher.vpc_config) == 0
    )
    error_message = "The API, migrate and worker Lambdas each run in their own security group; the fetcher stays outside the VPC (the renderer's no-VPC pin is in its own run)."
  }

  # --- The Function URL ------------------------------------------------------
  # NONE, with the CloudFront shared secret checked first in the app
  # (backend/src/app.ts). Its two public permissions (InvokeFunctionUrl, and
  # InvokeFunction only via the URL) are added by the provider when it creates
  # the URL, not declared (lambda.tf), so they can't be asserted here; the
  # post-apply check's Function URL 403 is the live proof. Moving to AWS_IAM
  # means CloudFront OAC for Lambda plus a body-hash change in the SPA; either
  # way, a deliberate edit here.
  assert {
    condition     = aws_lambda_function_url.backend.authorization_type == "NONE"
    error_message = "The Function URL is authorization_type NONE (shared secret in the app); its public permissions come from the provider on create (lambda.tf)."
  }

  # --- Security-group descriptions, verbatim -------------------------------
  # A description can't change in place: AWS replaces the group, and deleting
  # one a Lambda ENI still holds can stall an apply for 20+ minutes. Pinning
  # the text makes any edit a deliberate change here, made knowing that.
  assert {
    condition = {
      api_lambda     = aws_security_group.api_lambda.description
      migrate_lambda = aws_security_group.migrate_lambda.description
      worker_lambda  = aws_security_group.worker_lambda.description
      rds            = aws_security_group.rds.description
      vpce           = aws_security_group.vpce.description
      vpce_sqs       = aws_security_group.vpce_sqs.description
      vpce_ses       = aws_security_group.vpce_ses.description
      vpce_s3        = aws_security_group.vpce_s3.description
      } == {
      api_lambda     = "API Lambda ENIs: egress to Postgres and the SQS, SES, S3 and Secrets Manager endpoints only."
      migrate_lambda = "Migrate Lambda ENIs: egress to Postgres and the Secrets Manager and S3 endpoints only."
      worker_lambda  = "Worker Lambda ENIs: egress to Postgres and the SQS, SES, S3 and Secrets Manager endpoints only."
      rds            = "RDS Postgres: ingress 5432 from the API, migrate and worker Lambda SGs only; no egress."
      vpce           = "Secrets Manager interface endpoint: 443 from the migrate, API and worker Lambdas only."
      vpce_sqs       = "SQS interface endpoint: 443 from the API and worker Lambdas only."
      vpce_ses       = "SES API interface endpoint: 443 from the API and worker Lambdas only."
      vpce_s3        = "S3 interface endpoint: 443 from the API, worker and migrate Lambdas only."
    }
    error_message = "A security-group description changed. That replaces the group on the next apply (see the comment above); update this pin only if you mean it."
  }
  assert {
    condition = aws_vpc.main.cidr_block != "" && alltrue([
      for f in fileset(".", "*.tf") :
      length(regexall("resource \"aws_security_group\"", file(f))) == length(regexall("resource \"aws_security_group\" \"(api_lambda|migrate_lambda|worker_lambda|rds|vpce|vpce_sqs|vpce_ses|vpce_s3|assistant_lambda|bedrock_vpce)\"", file(f)))
    ])
    error_message = "A new security group needs its description pinned in the assert above (the assistant's two, which exist only with assistant_enabled, in assistant.tftest.hcl)."
  }
  assert {
    condition = alltrue([
      for d in [
        aws_security_group.api_lambda.description, aws_security_group.migrate_lambda.description,
        aws_security_group.worker_lambda.description, aws_security_group.rds.description,
        aws_security_group.vpce.description, aws_security_group.vpce_sqs.description,
        aws_security_group.vpce_ses.description, aws_security_group.vpce_s3.description,
      ] : length(d) <= 255 && can(regex("^[a-zA-Z0-9. _:/()#,@\\[\\]+=&;{}!$*-]+$", d))
    ])
    error_message = "Security-group descriptions are limited to 255 characters of a-zA-Z0-9. _-:/()#,@[]+=&;{}!$* (no apostrophes, no em dashes), or AWS rejects the create."
  }
}
