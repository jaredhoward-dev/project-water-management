# ----------------------------------------------------------------------------
# Fixed egress (var.fixed_egress_enabled; modules/fixed-egress,
# docs/deployment.md § Fixed egress)
#
# The fetcher (feeds.tf) and the mirror-ingest job (ingest.tf) are the
# Lambdas that call upstreams with per-address limits (CHC above all). Off,
# they run outside any VPC and leave from AWS's shared Lambda addresses; on,
# they run in their own small egress VPC and leave from one Elastic IP, ours
# alone. The private VPC (network.tf) is untouched either way: the egress VPC
# is a separate VPC, never peered, holding nothing but these two Lambdas'
# ENIs, so neither Lambda gains a path to the database.
# ----------------------------------------------------------------------------

locals {
  fixed_egress_on = var.fixed_egress_enabled

  # Both Lambdas' vpc_config while it is on (an empty list otherwise).
  fixed_egress_vpc_config = local.fixed_egress_on ? [{
    subnet_ids         = module.fixed_egress[0].private_subnet_ids
    security_group_ids = [module.fixed_egress[0].lambda_security_group_id]
  }] : []
}

module "fixed_egress" {
  source = "./modules/fixed-egress"
  count  = local.fixed_egress_on ? 1 : 0

  project       = local.project
  vpc_cidr      = var.fixed_egress_vpc_cidr
  zone_ids      = local.subnet_zone_ids
  instance_type = var.fixed_egress_instance_type
  # The NAT instance's recover and reboot alarms page at the essential tier.
  alarm_topic_arns = local.alarms_essential ? [aws_sns_topic.alerts.arn] : []
}

# ----------------------------------------------------------------------------
# Stripe egress (var.stripe_egress_enabled; modules/stripe-egress,
# docs/deployment.md § Stripe egress)
#
# With billing_provider = "stripe" the API Lambda calls api.stripe.com
# (checkout, the Customer Portal, seat changes), but it lives in the private
# VPC, which has no way out (network.tf). On, the module adds a NAT gateway
# to that VPC and two subnets of its own routed through it, and the API
# Lambda moves its ENIs there and carries one more security group (HTTPS
# out). Nothing else moves: RDS, the worker, migrate and the endpoints keep
# the original route-less subnets, so RDS stays private. Off (the default),
# nothing is created and the API keeps network.tf's subnets.
# ----------------------------------------------------------------------------

locals {
  stripe_egress_on = var.stripe_egress_enabled

  # The API Lambda's vpc_config: the module's subnets and both groups while
  # it is on, network.tf's subnets and the API group alone otherwise.
  api_subnet_ids = local.stripe_egress_on ? module.stripe_egress[0].api_subnet_ids : aws_subnet.private[*].id
  api_security_group_ids = concat(
    [aws_security_group.api_lambda.id],
    local.stripe_egress_on ? [module.stripe_egress[0].api_security_group_id] : [],
  )
}

module "stripe_egress" {
  source = "./modules/stripe-egress"
  count  = local.stripe_egress_on ? 1 : 0

  project  = local.project
  vpc_id   = aws_vpc.main.id
  vpc_cidr = var.vpc_cidr
  zone_ids = local.subnet_zone_ids
}
