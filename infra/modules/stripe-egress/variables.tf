variable "project" {
  description = "Name prefix (local.project in the root module)."
  type        = string
}

variable "vpc_id" {
  description = "The private VPC (network.tf aws_vpc.main)."
  type        = string
}

variable "vpc_cidr" {
  description = "The private VPC's CIDR (var.vpc_cidr). The module carves /24s 20 (public) and 21-22 (the API) from it; network.tf uses 10-11."
  type        = string
}

variable "zone_ids" {
  description = "The private subnets' two availability-zone IDs; the first also holds the public subnet and the NAT gateway."
  type        = list(string)

  validation {
    condition     = length(var.zone_ids) == 2
    error_message = "zone_ids takes exactly two zone IDs."
  }
}
